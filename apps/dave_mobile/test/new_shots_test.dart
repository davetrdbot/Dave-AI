// Screenshots of the newest screens (SCREENSHOTS_DIR=... flutter test test/new_shots_test.dart).
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dave_mobile/api/chat.dart';
import 'package:dave_mobile/api/client.dart';
import 'package:dave_mobile/app_scope.dart';
import 'package:dave_mobile/look.dart';
import 'package:dave_mobile/screens/extras.dart';
import 'package:dave_mobile/screens/growth.dart';
import 'package:dave_mobile/screens/incoming_call.dart';
import 'package:dave_mobile/theme.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final _dir = Platform.environment['SCREENSHOTS_DIR'];
const _frame = Key('frame');

Future<void> _fonts() async {
  final root = Platform.environment['FLUTTER_ROOT'];
  if (root == null) return;
  for (final family in ['Roboto', 'CupertinoSystemText', 'CupertinoSystemDisplay', '.SF Pro Text', '.SF Pro Display', 'monospace', 'Menlo']) {
    final loader = FontLoader(family);
    for (final w in ['Regular', 'Medium', 'Bold']) {
      final f = File('$root/bin/cache/artifacts/material_fonts/Roboto-$w.ttf');
      if (f.existsSync()) loader.addFont(Future.value(ByteData.sublistView(f.readAsBytesSync())));
    }
    await loader.load();
  }
  final config = jsonDecode(File('.dart_tool/package_config.json').readAsStringSync()) as Map;
  final pkg = (config['packages'] as List).cast<Map>().firstWhere((p) => p['name'] == 'cupertino_icons');
  final icons = File('${Uri.parse(pkg['rootUri'] as String).toFilePath()}/assets/CupertinoIcons.ttf');
  await (FontLoader('packages/cupertino_icons/CupertinoIcons')..addFont(Future.value(ByteData.sublistView(icons.readAsBytesSync())))).load();
}

Future<void> _shot(WidgetTester t, String name) async {
  final dir = _dir;
  if (dir == null) return;
  await t.runAsync(() async {
    final b = t.renderObject<RenderRepaintBoundary>(find.byKey(_frame));
    final img = await b.toImage(pixelRatio: 3);
    final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
    Directory(dir).createSync(recursive: true);
    File('$dir/$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
  });
}

Widget _app(Widget home, GlobalKey<NavigatorState>? nav, {Look look = Look.midnightLime}) => RepaintBoundary(
      key: _frame,
      child: LookScope(
        controller: LookController(look),
        child: CupertinoApp(
          navigatorKey: nav,
          debugShowCheckedModeBanner: false,
          theme: CupertinoThemeData(brightness: look.brightness, primaryColor: look.accent, scaffoldBackgroundColor: const Color(0x00000000), barBackgroundColor: look.base.withValues(alpha: 0.82)),
          builder: (context, child) => Stack(fit: StackFit.expand, children: [const Aurora(), ?child]),
          home: home,
        ),
      ),
    );

http.Client _server() => MockClient((req) async {
      final p = req.url.path;
      if (p.endsWith('/growth')) {
        final g = jsonDecode(File('test/fixtures/growth.json').readAsStringSync()) as Map<String, dynamic>;
        g['shareUrl'] = 'https://dave-bot-production.up.railway.app/api/share/growth/q8Zk3vYp1NwH5xTfR2mLc9aB0sDe';
        return http.Response(jsonEncode(g), 200, headers: {'content-type': 'application/json'});
      }
      if (p.endsWith('/analysis-scope')) return http.Response(File(Platform.environment['SCOPE_JSON']!).readAsStringSync(), 200, headers: {'content-type': 'application/json'});
      return http.Response('{}', 200, headers: {'content-type': 'application/json'});
    });

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _fonts();
  });

  Future<void> phone(WidgetTester t) async {
    t.view.physicalSize = const Size(1080, 2340);
    t.view.devicePixelRatio = 3;
    t.view.padding = const FakeViewPadding(top: 72, bottom: 48);
    addTearDown(t.view.reset);
  }

  Future<void> run(WidgetTester t) async {
    for (var i = 0; i < 10; i++) {
      await t.pump(const Duration(milliseconds: 100));
    }
  }

  testWidgets('incoming call', (t) async {
    await phone(t);
    final nav = GlobalKey<NavigatorState>();
    final chat = ChatApi(base: Uri.parse('https://x'), token: 't', client: _server());
    await t.pumpWidget(_app(const CupertinoPageScaffold(child: SizedBox()), nav));
    IncomingCallPage.show(nav.currentState!, api: chat, callId: 'c1', symbol: 'XAUUSD',
        reason: 'Gold swept the Asian low and shifted up on M15 -- the long at the H1 order block is ready. Do you want me to take it?');
    await t.pump();
    await t.pump(const Duration(milliseconds: 700));
    await _shot(t, 'call_incoming');
    IncomingCallPage.show(nav.currentState!, api: chat, callId: 'c2', urgent: true, symbol: 'VOL_10', reason: 'VOL_10 buy is 80% of the way to its stop and the H1 structure just shifted against it. Close it or hold?');
    await t.pump();
    await t.pump(const Duration(milliseconds: 1100));
    await _shot(t, 'call_urgent');
  });

  for (final look in [Look.midnightLime, Look.pearl]) {
    testWidgets('growth share (${look.name})', (t) async {
      await phone(t);
      final api = DaveApi(base: Uri.parse('https://x'), token: 't', client: _server());
      await t.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const GrowthScreen()), null, look: look));
      await run(t);
      await t.scrollUntilVisible(find.text('Import a link'), 400, scrollable: find.byType(Scrollable).first);
      await t.drag(find.byType(Scrollable).first, const Offset(0, 300));
      await run(t);
      await _shot(t, 'growth_share_${look.name}');
    });

    testWidgets('analysis scope (${look.name})', (t) async {
      await phone(t);
      final api = DaveApi(base: Uri.parse('https://x'), token: 't', client: _server());
      await t.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const AnalysisScopePage()), null, look: look));
      await run(t);
      await t.scrollUntilVisible(find.text('market structure'), 300, scrollable: find.byType(Scrollable).first);
      await t.drag(find.byType(Scrollable).first, const Offset(0, 160));
      await run(t);
      await _shot(t, 'scope_market_structure_${look.name}');
      await t.scrollUntilVisible(find.text('reference levels'), 400, scrollable: find.byType(Scrollable).first);
      await run(t);
      await _shot(t, 'scope_liquidity_context_${look.name}');
    });
  }
}
