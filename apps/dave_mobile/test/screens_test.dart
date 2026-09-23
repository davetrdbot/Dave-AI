// Renders every screen against a fake server, in light and dark, and fails on any exception or
// layout overflow. CI runs it as a smoke test.
//
// With SCREENSHOTS_DIR set it also writes each frame as a PNG, using real fonts (Roboto -- what
// Android falls back to for the Cupertino text styles -- and the Cupertino icon font), so the
// images look like the phone rather than the test font's black boxes:
//
//   SCREENSHOTS_DIR=/tmp/shots flutter test test/screens_test.dart
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:dave_mobile/api/client.dart';
import 'package:dave_mobile/app_scope.dart';
import 'package:dave_mobile/screens/connect.dart';
import 'package:dave_mobile/screens/shell.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

final _shotsDir = Platform.environment['SCREENSHOTS_DIR'];
const _frameKey = Key('frame');

Map<String, Object?> _dashboard() {
  final rng = Random(7);
  final today = DateTime.now();
  final buckets = <Map<String, Object?>>[];
  for (var i = 180; i >= 0; i--) {
    if (rng.nextDouble() < 0.45) continue; // most days nothing closes
    final d = today.subtract(Duration(days: i));
    final pnl = (rng.nextDouble() - 0.38) * 90;
    buckets.add({
      'day': '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}',
      'pnl': double.parse(pnl.toStringAsFixed(2)),
      'trades': 1 + rng.nextInt(4),
    });
  }
  final now = DateTime.now().millisecondsSinceEpoch;
  return {
    'account': {'balance': 2481.36, 'equity': 2512.86, 'freeMargin': 2301.1, 'leverage': 500, 'updatedAt': now - 8000},
    'ea': {'connected': true, 'lastSeenAt': now - 4000},
    'open': {
      'positions': [
        {'ticket': '51770012', 'symbol': 'Volatility 75 Index', 'type': 'sell', 'lots': 0.01, 'openPrice': 196740.52, 'sl': 197400, 'tp': 195300, 'currentPrice': 196102.4, 'pnl': 38.2},
        {'ticket': '51770047', 'symbol': 'XAUUSD', 'type': 'buy', 'lots': 0.1, 'openPrice': 2651.4, 'sl': 2644, 'tp': 2670, 'currentPrice': 2650.7, 'pnl': -6.7},
      ],
      'pendingOrders': [
        {'ticket': '51770090', 'symbol': 'EURUSD', 'type': 'buy_limit', 'lots': 0.2, 'price': 1.0921},
      ],
      'count': 2,
      'maxOpenTrades': 3,
    },
    'results': {'closedTrades': 64, 'wins': 39, 'losses': 25, 'winRatePercent': 61, 'realisedPnl': 612.44},
    'heatmap': {'days': 365, 'buckets': buckets},
    'emptyReason': null,
  };
}

final _brain = {
  'memory': {
    'user': ['Trades from Lagos, usually online 8am to 11pm WAT.', 'Prefers short answers and one clear recommendation.', 'Account currency is USD.'],
    'notes': ['Keep risk at 1% per trade unless told otherwise.', 'Asked to be told before any trade over 0.05 lots on synthetics.'],
    'usedChars': 1180,
    'budgetChars': 2200,
    'usagePercent': 54,
    'entryCount': 5,
  },
  'knowledge': {
    'count': 7,
    'entries': [
      for (final (i, t) in [
        ('V75 fakes the first London breakout', 'A London-open breakout on V75 with no retest'),
        ('Gold respects the Asian range', 'Planning XAUUSD entries before London'),
        ('Losses cluster after 3 wins', 'After a winning streak, before sizing up'),
        ('Wide SL on Boom 1000 gets hunted', 'Setting stops on Boom/Crash indices'),
        ('NFP day: stand aside first 15 min', 'First Friday of the month'),
        ('Trend days close near the high', 'Deciding whether to hold into the close'),
        ('Spread widens at rollover', 'Any entry between 23:55 and 00:10 server time'),
      ].indexed)
        {'id': 'k$i', 'title': t.$1, 'useWhen': t.$2, 'createdAt': DateTime.now().millisecondsSinceEpoch, 'chars': 300 + i * 170},
    ],
  },
};

final _skills = [
  {'id': 'smc', 'name': 'Smart money concepts', 'description': 'Order blocks, liquidity sweeps and fair value gaps on the 15m with a 4h bias.', 'source': 'github', 'permanent': false, 'active': true, 'contentChars': 5200},
  {'id': 'default-analysis', 'name': 'Default analysis', 'description': 'Dave\'s built-in multi-timeframe read. Always available.', 'source': 'built-in', 'permanent': true, 'active': false, 'contentChars': 3100},
  {'id': 'breakout', 'name': 'Range breakout', 'description': 'Asian range high/low breakout with a retest entry.', 'source': 'self-created', 'permanent': false, 'active': false, 'contentChars': 1800},
];

http.Client _fakeServer() => MockClient((req) async {
      Object? body;
      switch (req.url.path) {
        case '/api/app/dashboard':
          body = _dashboard();
        case '/api/app/brain':
          body = _brain;
        case '/api/app/skills':
          final id = req.url.queryParameters['id'];
          body = id == null
              ? {'skills': _skills}
              : {
                  ..._skills.firstWhere((s) => s['id'] == id),
                  'content': '# Smart money concepts\n\n## Bias\nRead the 4h structure first. Only trade in its direction.\n\n## Entry\n1. Wait for a sweep of the previous session high or low.\n2. Enter on the first 15m order block after the sweep.\n3. Stop beyond the sweep wick. Target the opposite liquidity pool.\n',
                };
        case '/api/app/bot':
          body = {'running': true, 'executionEnabled': true, 'intervalMinutes': 5, 'intervalBounds': {'min': 1, 'max': 60}};
        default:
          return http.Response('{"error":"not found"}', 404);
      }
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
    });

Future<void> _loadFonts() async {
  final flutterRoot = Platform.environment['FLUTTER_ROOT'];
  if (flutterRoot == null) return;
  final roboto = '$flutterRoot/bin/cache/artifacts/material_fonts';
  for (final family in ['Roboto', 'CupertinoSystemText', 'CupertinoSystemDisplay', '.SF Pro Text', '.SF Pro Display', 'monospace']) {
    final loader = FontLoader(family);
    for (final weight in ['Regular', 'Medium', 'Bold']) {
      final f = File('$roboto/Roboto-$weight.ttf');
      if (f.existsSync()) loader.addFont(Future.value(ByteData.sublistView(f.readAsBytesSync())));
    }
    await loader.load();
  }
  final config = jsonDecode(File('.dart_tool/package_config.json').readAsStringSync()) as Map;
  final pkg = (config['packages'] as List).cast<Map>().firstWhere((p) => p['name'] == 'cupertino_icons');
  final icons = File('${Uri.parse(pkg['rootUri'] as String).toFilePath()}/assets/CupertinoIcons.ttf');
  await (FontLoader('packages/cupertino_icons/CupertinoIcons')..addFont(Future.value(ByteData.sublistView(icons.readAsBytesSync())))).load();
}

Future<void> _shot(WidgetTester tester, String name) async {
  final dir = _shotsDir;
  if (dir == null) return;
  await tester.runAsync(() async {
    final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(_frameKey));
    final image = await boundary.toImage(pixelRatio: tester.view.devicePixelRatio);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    Directory(dir).createSync(recursive: true);
    File('$dir/$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
  });
}

/// Lets the fake requests resolve and animations run a little, without pumpAndSettle -- the
/// activity indicators and the dashboard's refresh timer never "settle".
Future<void> _advance(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Widget _app(Widget home) => RepaintBoundary(
      key: _frameKey,
      child: CupertinoApp(
        debugShowCheckedModeBanner: false,
        theme: const CupertinoThemeData(primaryColor: CupertinoColors.systemBlue),
        home: home,
      ),
    );

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferencesAsyncPlatform.instance = InMemorySharedPreferencesAsync.empty();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('flutter_foreground_task/methods'),
      (call) async => false,
    );
    await _loadFonts();
  });

  for (final brightness in Brightness.values) {
    final mode = brightness.name;

    testWidgets('every tab renders ($mode)', (tester) async {
      tester.view.physicalSize = const Size(1080, 2340); // a common Android phone, 360x780 dp
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 72, bottom: 48);
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);

      final api = DaveApi(base: Uri.parse('https://dave-bot-production.up.railway.app'), token: 't', client: _fakeServer());
      await tester.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const Shell())));
      await _advance(tester);

      await _shot(tester, 'home_$mode');
      expect(find.text('Dave'), findsWidgets);
      expect(find.textContaining('Volatility 75 Index'), findsOneWidget);

      await tester.drag(find.byType(CustomScrollView).first, const Offset(0, -900));
      await _advance(tester);
      await _shot(tester, 'home_scrolled_$mode');

      await tester.tap(find.byIcon(CupertinoIcons.lightbulb).last);
      await _advance(tester);
      await _shot(tester, 'brain_$mode');
      expect(find.textContaining('54% full'), findsOneWidget);

      await tester.tap(find.byIcon(CupertinoIcons.square_stack_3d_up).last);
      await _advance(tester);
      await _shot(tester, 'skills_$mode');
      expect(find.text('Range breakout'), findsOneWidget);

      await tester.tap(find.text('Range breakout'));
      await _advance(tester);
      await _shot(tester, 'skill_detail_$mode');
      expect(find.text('Use this strategy'), findsOneWidget);
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);

      await tester.tap(find.byIcon(CupertinoIcons.gear_alt).last);
      await _advance(tester);
      await _shot(tester, 'settings_$mode');
      expect(find.text('Autonomous trading'), findsOneWidget);
      expect(find.text('5 min'), findsOneWidget);

      await tester.pumpWidget(const SizedBox()); // dispose, cancelling the dashboard's refresh timer
    });

    testWidgets('connect screen renders ($mode)', (tester) async {
      tester.view.physicalSize = const Size(1080, 2340);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 72, bottom: 48);
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);

      await tester.pumpWidget(_app(ConnectScreen(onConnected: (_, _) {}, notice: brightness == Brightness.dark ? 'This phone was disconnected. Pair it again from the web panel.' : null)));
      await _advance(tester);
      expect(find.text('Connect to Dave'), findsOneWidget);
      await _shot(tester, 'connect_$mode');
    });
  }
}
