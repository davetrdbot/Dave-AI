import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import 'api/client.dart';
import 'app_scope.dart';
import 'push/push_service.dart';
import 'screens/connect.dart';
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

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _look.load();
    _restore();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
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
