import 'dart:async';
import 'dart:convert';

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'api/chat.dart';
import 'api/client.dart';
import 'app_scope.dart';
import 'push/push_service.dart';
import 'screens/connect.dart';
import 'screens/incoming_call.dart';
import 'screens/voice.dart';
import 'screens/shell.dart';
import 'session.dart';
import 'look.dart';
import 'theme.dart';

/// Dave -- the app.
///
/// A live window onto the trading bot, its controls, and Dave himself: the Chat tab is the same
/// conversation as Telegram (every tool call and thought shown as it happens), and the Live tab
/// is the autonomous loop in real time.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  PushService.initPort();
  runApp(const DaveApp());
}

class DaveApp extends StatefulWidget {
  const DaveApp({super.key});

  @override
  State<DaveApp> createState() => _DaveAppState();
}

class _DaveAppState extends State<DaveApp> with WidgetsBindingObserver {
  bool _loading = true;
  DaveApi? _api;
  final _look = LookController();
  String? _notice;
  final _nav = GlobalKey<NavigatorState>();
  final _notifications = FlutterLocalNotificationsPlugin();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _look.load();
    _restore();
    // Dave calling while the app is open: the background service hands the call straight here.
    FlutterForegroundTask.addTaskDataCallback(_onTaskData);
    unawaited(_initCallNotifications());
  }

  @override
  void dispose() {
    FlutterForegroundTask.removeTaskDataCallback(_onTaskData);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _onTaskData(Object data) {
    if (data is Map && data['call'] is Map) _ringInApp((data['call'] as Map).cast<String, dynamic>());
  }

  /// Taps on the call notification (Answer, or the notification itself) and an app launched by
  /// its full-screen intent all end up here.
  Future<void> _initCallNotifications() async {
    try {
      await _notifications.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@drawable/ic_stat_dave'),
          iOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false),
        ),
        onDidReceiveNotificationResponse: _onNotificationTap,
        onDidReceiveBackgroundNotificationResponse: onCallActionInBackground,
      );
      final launch = await _notifications.getNotificationAppLaunchDetails();
      final r = launch?.notificationResponse;
      if (launch?.didNotificationLaunchApp == true && r != null) {
        // Wait for the session to load before showing anything.
        for (var i = 0; i < 40 && (_loading || _api == null); i++) {
          await Future<void>.delayed(const Duration(milliseconds: 150));
        }
        _onNotificationTap(r);
      }
    } catch (_) {
      // notifications unavailable (tests, desktop) -- calls still ring in the app
    }
  }

  Map<String, dynamic>? _callOf(NotificationResponse r) {
    try {
      final p = jsonDecode(r.payload ?? '');
      return p is Map && p['call'] is Map ? (p['call'] as Map).cast<String, dynamic>() : null;
    } catch (_) {
      return null;
    }
  }

  void _onNotificationTap(NotificationResponse r) {
    final call = _callOf(r);
    if (call == null) return;
    unawaited(_notifications.cancel(id: callNotificationId('${call['id']}')));
    if (r.actionId == 'decline') {
      unawaited(reportCallFromNotification(r, 'declined'));
      return;
    }
    final api = _api, nav = _nav.currentState;
    if (api == null || nav == null) return;
    if (r.actionId == 'answer') {
      unawaited(LiveOptions.load().then((o) => nav.push(CupertinoPageRoute<void>(
            fullscreenDialog: true,
            builder: (_) => LiveCallPage(api: ChatApi.of(api), options: o, callId: '${call['id']}'),
          ))));
      return;
    }
    _ringInApp(call);
  }

  void _ringInApp(Map<String, dynamic> call) {
    final api = _api, nav = _nav.currentState;
    if (api == null || nav == null || '${call['id'] ?? ''}'.isEmpty) return;
    unawaited(IncomingCallPage.show(nav,
        api: ChatApi.of(api), callId: '${call['id']}', reason: '${call['reason'] ?? ''}', symbol: '${call['symbol'] ?? ''}', urgent: call['urgent'] == true));
  }

  /// The notification service skips "Dave replied" while the app is on screen.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => PushService.setAppVisible(state == AppLifecycleState.resumed);

  /// A paired phone opens straight onto its dashboard -- the endpoint and token persist, so the
  /// "power up" happens once, not on every launch.
  Future<void> _restore() async {
    final session = await Session.load();
    final notice = await Session.takeUnpairedNotice();
    if (!mounted) return;
    setState(() {
      _api = session == null ? null : DaveApi(base: session.endpoint, token: session.token);
      _notice = notice;
      _loading = false;
    });
    if (session != null) await _ensurePush();
  }

  /// (Re)starting the service is also the catch-up: its first act is to fetch anything that
  /// happened while it was not running.
  Future<void> _ensurePush() async {
    if (!await Session.notificationsEnabled()) return;
    if (!await PushService.requestNotificationPermission()) return;
    await PushService.start();
    PushService.setAppVisible(true);
  }

  void _connected(Uri endpoint, String token) {
    setState(() {
      _api = DaveApi(base: endpoint, token: token);
      _notice = null;
    });
    _ensurePush();
  }

  /// Another saved bot becomes the one on screen; null = go pair one more (this one stays saved).
  Future<void> _switchBot(SavedBot? bot) async {
    final current = _api?.base.toString();
    await PushService.stop();
    _api?.close();
    if (bot == null) {
      _returnTo = (await Session.accounts()).where((b) => b.endpoint.toString() == current).firstOrNull;
      setState(() {
        _api = null;
        _notice = 'Pair another bot. The ones you already paired stay in Settings → Bots.';
      });
      return;
    }
    await Session.activate(bot);
    _returnTo = null;
    if (!mounted) return;
    setState(() => _api = DaveApi(base: bot.endpoint, token: bot.token));
    await _ensurePush();
  }

  /// The bot to go back to if the trader backs out of pairing another one.
  SavedBot? _returnTo;

  Future<void> _unpaired(String reason) async {
    if (_api == null) return; // several screens can notice at once; handle it once
    _api?.close();
    setState(() {
      _api = null;
      _notice = reason;
    });
    await PushService.stop();
    await Session.clear();
    // Other bots paired on this phone stay one tap away from the connect screen.
    final others = await Session.accounts().catchError((_) => <SavedBot>[]);
    if (mounted && others.isNotEmpty) setState(() => _returnTo = others.first);
  }

  @override
  Widget build(BuildContext context) {
    final Widget home;
    if (_loading) {
      home = const CupertinoPageScaffold(child: Center(child: CupertinoActivityIndicator(radius: 14)));
    } else if (_api == null) {
      home = ConnectScreen(onConnected: _connected, notice: _notice, onCancel: _returnTo == null ? null : () => _switchBot(_returnTo));
    } else {
      home = AppScope(api: _api!, onUnpaired: _unpaired, onSwitchBot: _switchBot, child: Shell(key: ValueKey(_api!.base.toString())));
    }
    // The chosen look (Settings -> Appearance) themes the whole app and repaints it on a switch.
    return LookScope(
      controller: _look,
      child: ValueListenableBuilder<Look>(
        valueListenable: _look,
        builder: (context, look, _) => AnnotatedRegion<SystemUiOverlayStyle>(
          value: SystemUiOverlayStyle(
            statusBarColor: const Color(0x00000000),
            systemNavigationBarColor: const Color(0x00000000),
            statusBarIconBrightness: look.dark ? Brightness.light : Brightness.dark,
            statusBarBrightness: look.brightness,
          ),
          child: CupertinoApp(
            navigatorKey: _nav,
            title: 'Dave',
            debugShowCheckedModeBanner: false,
            theme: CupertinoThemeData(
              brightness: look.brightness,
              primaryColor: look.accent,
              scaffoldBackgroundColor: const Color(0x00000000),
              barBackgroundColor: look.base.withValues(alpha: 0.82),
            ),
            // Every screen -- pushed ones too -- sits on the look's background (theme.dart).
            builder: (context, child) => Stack(fit: StackFit.expand, children: [const Aurora(), ?child]),
            home: home,
          ),
        ),
      ),
    );
  }
}
