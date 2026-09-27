import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../app_scope.dart';
import '../theme.dart';

/// The MT5 container's screen, live -- tap to click, drag to move, the keyboard to type. Like
/// having the VPS in your pocket. noVNC runs in the MT5 container; the bot relays it after
/// checking this phone's pairing (the token swaps for a short cookie and never reaches MT5).
class Mt5ScreenPage extends StatefulWidget {
  const Mt5ScreenPage({super.key});

  /// The viewer's address for this server and phone.
  static Uri address(Uri base, String token) => base.replace(path: '/mt5-screen/vnc.html', queryParameters: {
        'autoconnect': '1',
        'reconnect': '1',
        'resize': 'scale',
        'show_dot': '1',
        'path': 'mt5-screen/websockify',
        'token': token,
      });

  @override
  State<Mt5ScreenPage> createState() => _Mt5ScreenPageState();
}

class _Mt5ScreenPageState extends State<Mt5ScreenPage> {
  WebViewController? _web;
  bool _loading = true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_web != null) return;
    final api = AppScope.of(context).api;
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF000000))
      ..setNavigationDelegate(NavigationDelegate(onPageFinished: (_) {
        if (mounted) setState(() => _loading = false);
      }))
      ..loadRequest(Mt5ScreenPage.address(api.base, api.token));
    // The terminal is landscape; let the phone turn.
    SystemChrome.setPreferredOrientations(DeviceOrientation.values);
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CupertinoPageScaffold(
        backgroundColor: const Color(0xFF000000),
        navigationBar: CupertinoNavigationBar(
          middle: const Text('MT5 screen'),
          backgroundColor: glassBar,
          trailing: CupertinoButton(
            padding: EdgeInsets.zero,
            onPressed: () {
              setState(() => _loading = true);
              _web?.reload();
            },
            child: const Icon(CupertinoIcons.refresh),
          ),
        ),
        child: SafeArea(
          child: Stack(children: [
            if (_web != null) WebViewWidget(controller: _web!),
            if (_loading) const Center(child: CupertinoActivityIndicator(radius: 14, color: CupertinoColors.white)),
          ]),
        ),
      );
}
