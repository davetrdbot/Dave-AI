import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import 'api/client.dart';
import 'app_scope.dart';
import 'push/push_service.dart';
import 'screens/connect.dart';
import 'screens/shell.dart';
import 'session.dart';
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
  String? _notice;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
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

  Future<void> _unpaired(String reason) async {
    if (_api == null) return; // several screens can notice at once; handle it once
    _api?.close();
    setState(() {
      _api = null;
      _notice = reason;
    });
    await PushService.stop();
    await Session.clear();
  }

  @override
  Widget build(BuildContext context) {
    final Widget home;
    if (_loading) {
      home = const CupertinoPageScaffold(child: Center(child: CupertinoActivityIndicator(radius: 14)));
    } else if (_api == null) {
      home = ConnectScreen(onConnected: _connected, notice: _notice);
    } else {
      home = AppScope(api: _api!, onUnpaired: _unpaired, child: const Shell());
    }
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: const SystemUiOverlayStyle(statusBarColor: Color(0x00000000), systemNavigationBarColor: Color(0x00000000)),
      child: CupertinoApp(
        title: 'Dave',
        debugShowCheckedModeBanner: false,
        // No brightness set: the app follows the system, light by default and dark when chosen.
        theme: const CupertinoThemeData(primaryColor: CupertinoColors.systemBlue, scaffoldBackgroundColor: Color(0x00000000), barBackgroundColor: glassBar),
        // Every screen -- pushed ones too -- sits on the same soft colour field (theme.dart).
        builder: (context, child) => Stack(fit: StackFit.expand, children: [const Aurora(), ?child]),
        home: home,
      ),
    );
  }
}
