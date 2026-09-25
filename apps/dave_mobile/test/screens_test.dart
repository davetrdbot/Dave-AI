// Renders every screen against a fake server, in light and dark, and fails on any exception or
// layout overflow. CI runs it as a smoke test.
//
// With SCREENSHOTS_DIR set it also writes each frame as a PNG, using real fonts (Roboto -- what
// Android falls back to for the Cupertino text styles -- and the Cupertino icon font), so the
// images look like the phone rather than the test font's black boxes:
//
//   SCREENSHOTS_DIR=/tmp/shots flutter test test/screens_test.dart
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:dave_mobile/api/client.dart';
import 'package:dave_mobile/app_scope.dart';
import 'package:dave_mobile/screens/connect.dart';
import 'package:dave_mobile/screens/shell.dart';
import 'package:dave_mobile/theme.dart';
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
  // Individual closes for the range views: a year of history plus a few from today.
  final trades = <Map<String, Object?>>[];
  final symbols = ['XAUUSD', 'Volatility 75 Index', 'EURUSD', 'GBPJPY'];
  for (final b in buckets) {
    final day = DateTime.parse(b['day']! as String);
    final n = b['trades']! as int;
    for (var k = 0; k < n; k++) {
      trades.add({
        'at': day.add(Duration(hours: 8 + k * 3, minutes: 17 * k)).millisecondsSinceEpoch,
        'pnl': double.parse(((b['pnl']! as double) / n).toStringAsFixed(2)),
        'symbol': symbols[k % symbols.length],
        'side': k.isEven ? 'buy' : 'sell',
      });
    }
  }
  final midnight = DateTime(today.year, today.month, today.day);
  for (final (h, pnl) in [(1, 12.4), (3, -6.1), (4, 18.9), (7, 9.3)]) {
    final at = midnight.add(Duration(hours: h, minutes: 12));
    if (at.isBefore(today)) trades.add({'at': at.millisecondsSinceEpoch, 'pnl': pnl, 'symbol': 'XAUUSD', 'side': 'buy'});
  }
  trades.sort((a, b) => (a['at']! as int).compareTo(b['at']! as int));
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
    'trades': trades,
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

/// A day of usage in the phone's own time zone, busiest in the afternoon, plus the last requests.
Map<String, Object?> _context() {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final hours = <Map<String, Object?>>[];
  for (var h = 0; h <= 23; h++) {
    final at = today.add(Duration(hours: h));
    if (at.isAfter(now) || h < 7) continue;
    final calls = 20 + (h - 7) * 3;
    hours.add({
      'start': at.millisecondsSinceEpoch,
      'calls': calls,
      'promptTokens': calls * 9800,
      'completionTokens': calls * 240,
      'cachedTokens': calls * 4000,
      'estimatedCalls': 0,
      'peakPromptTokens': 41200 + h * 300,
      'bySource': {'autonomous': {'calls': calls - 4, 'tokens': (calls - 4) * 9000}, 'chat': {'calls': 4, 'tokens': 4 * 30000}},
    });
  }
  hours.add({'start': today.subtract(const Duration(hours: 5)).millisecondsSinceEpoch, 'calls': 40, 'promptTokens': 400000, 'completionTokens': 9000, 'cachedTokens': 0, 'estimatedCalls': 0, 'peakPromptTokens': 30000, 'bySource': {'autonomous': {'calls': 40, 'tokens': 409000}}});
  return {
    'current': {'provider': 'baseten', 'providerName': 'Baseten Model APIs', 'model': 'deepseek-ai/DeepSeek-V3.2', 'contextWindow': 163840},
    'chat': {
      'at': now.subtract(const Duration(minutes: 3)).millisecondsSinceEpoch,
      'source': 'chat',
      'provider': 'baseten',
      'model': 'deepseek-ai/DeepSeek-V3.2',
      'promptTokens': 38650,
      'completionTokens': 410,
      'cachedTokens': 21000,
      'estimated': false,
      'contextWindow': 163840,
      'parts': {'tools': 24100, 'systemPrompt': 6200, 'messages': 5100, 'skills': 1650, 'memory': 900, 'liveContext': 700},
      'toolCount': 128,
      'messageCount': 23,
    },
    'autonomous': null,
    'hours': hours,
  };
}

http.Client _fakeServer() => MockClient((req) async {
      Object? body;
      switch (req.url.path) {
        case '/api/app/dashboard':
          body = _dashboard();
        case '/api/app/brain':
          final kid = req.url.queryParameters['knowledgeId'];
          body = kid == null ? _brain : {'id': kid, 'title': 'V75 fakes the first London breakout', 'useWhen': 'A London-open breakout on V75 with no retest', 'content': 'The first push out of the Asian range on V75 reverses more often than not.', 'createdAt': 0};
        case '/api/app/settings':
          body = jsonDecode(File('test/fixtures/settings.json').readAsStringSync());
        case '/api/app/provider':
          body = {
            'provider': 'baseten',
            'name': 'Baseten Model APIs',
            'defaultModel': 'deepseek-ai/DeepSeek-V3.2',
            'isPrimary': true,
            'keys': [
              {'id': 'k1', 'label': 'Baseten 1', 'maskedKey': 'bt-l…6789', 'model': 'deepseek-ai/DeepSeek-V3.2', 'healthy': true, 'isPrimary': true, 'lastError': null},
              {'id': 'k2', 'label': 'Baseten 2', 'maskedKey': 'bt-l…1f2e', 'model': 'deepseek-ai/DeepSeek-V3.2', 'healthy': false, 'isPrimary': false, 'lastError': 'Rate limited, retry in 30s'},
            ],
          };
        case '/api/app/providers':
          body = {
            'primary': 'baseten',
            'backups': ['deepseek'],
            'providers': [
              {'provider': 'baseten', 'name': 'Baseten Model APIs', 'keyCount': 2, 'healthyKeys': 1, 'model': 'deepseek-ai/DeepSeek-V3.2', 'isPrimary': true, 'backupPosition': null},
              {'provider': 'deepseek', 'name': 'DeepSeek', 'keyCount': 1, 'healthyKeys': 1, 'model': 'deepseek-chat', 'isPrimary': false, 'backupPosition': 1},
              {'provider': 'groq', 'name': 'Groq', 'keyCount': 1, 'healthyKeys': 1, 'model': 'llama-3.3-70b-versatile', 'isPrimary': false, 'backupPosition': null},
              {'provider': 'claude', 'name': 'Anthropic Claude', 'keyCount': 0, 'healthyKeys': 0, 'model': 'claude-sonnet-5', 'isPrimary': false, 'backupPosition': null},
              {'provider': 'openai', 'name': 'OpenAI', 'keyCount': 0, 'healthyKeys': 0, 'model': 'gpt-5', 'isPrimary': false, 'backupPosition': null},
            ],
          };
        case '/api/app/context':
          body = _context();
        case '/api/app/mt5':
          body = {
            'agent': {'url': 'http://dave-mt5.railway.internal:8081'},
            'pairGroup': ['VOL_80', 'BOOM_100', 'CRASH_500', 'VOL_75'],
            'summary': 'MT5 is running and logged in (40123456 on Deriv-Demo, chart VOL_80 M1). The EA last reported 3s ago.',
            'status': {
              'installed': true, 'compiled': true, 'running': true, 'login': 'logged-in', 'configured': true,
              'account': {'login': '40123456', 'server': 'Deriv-Demo', 'symbol': 'VOL_80', 'period': 'M1'},
              'inputs': {'PushSeconds': 8},
              'marketWatch': ['VOL_80', 'BOOM_100', 'CRASH_500'],
              'metaquotesIds': ['1A2B3C4D'],
              'phonePush': {'state': 'on', 'detail': null, 'eaReports': true},
              'relay': {'count': 1200, 'errors': 0, 'lastAt': DateTime.now().millisecondsSinceEpoch / 1000 - 3, 'lastStatus': 200},
            },
          };
        case '/api/app/trades':
          body = {'ok': true};
        case '/api/app/skills':
          final id = req.url.queryParameters['id'];
          body = id == null
              ? {'skills': _skills}
              : {
                  ..._skills.firstWhere((s) => s['id'] == id),
                  'content': '# Smart money concepts\n\n## Bias\nRead the 4h structure first. Only trade in its direction.\n\n## Entry\n1. Wait for a sweep of the previous session high or low.\n2. Enter on the first 15m order block after the sweep.\n3. Stop beyond the sweep wick. Target the opposite liquidity pool.\n',
                };
        case '/api/app/chat/history':
          body = {
            'latestEventId': 40,
            'items': [
              {'role': 'user', 'text': 'How is gold looking?'},
              {
                'role': 'assistant',
                'text': '**Gold** is holding above the Asian low.\n\n| Level | Price |\n|---|---|\n| Support | 2,644 |\n| Resistance | 2,670 |\n\nI would wait for a pullback to *2,648* before buying.',
                'tools': [{'name': 'get_price'}, {'name': 'get_candles'}],
              },
            ],
          };
        case '/api/app/chat/activity':
          body = {'events': [], 'latestEventId': 40};
        case '/api/app/bot':
          body = {'running': true, 'executionEnabled': true, 'intervalMinutes': 5, 'intervalBounds': {'min': 1, 'max': 60}};
        default:
          return http.Response('{"error":"not found"}', 404);
      }
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
    });

/// The chat's live feed: a few events, then the connection stays open like the real one.
http.Client _fakeChatStream() => MockClient.streaming((req, _) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      var id = 40;
      String frame(String kind, Map<String, Object?> data, {String feed = 'chat', String? turnId = 't1', String? agent}) => 'id: ${++id}\nevent: activity\ndata: ${jsonEncode({
            'id': id,
            'at': now,
            'feed': feed,
            'kind': kind,
            'turnId': ?turnId,
            'channel': 'app',
            'agent': ?agent,
            'data': data,
          })}\n\n';
      final controller = StreamController<List<int>>();
      controller.add(utf8.encode([
        'event: ready\ndata: {"latestEventId":40,"busy":true,"task":"(app) buy gold?","appTurn":true}\n\n',
        frame('user_message', {'text': 'Should I buy gold now?', 'images': 1}),
        frame('turn_start', {}),
        frame('thinking', {'text': 'The trader wants an entry. Check price and structure first.'}),
        frame('tool_start', {'id': 'a', 'name': 'get_price', 'label': 'Checking price', 'args': {'symbol': 'XAUUSD'}}),
        frame('tool_end', {'id': 'a', 'name': 'get_price', 'label': 'Checking price', 'result': {'bid': 2651.2}, 'ms': 420}),
        frame('text', {'text': 'Price is 2,651. Looking for structure.'}),
        frame('tool_start', {'id': 'b', 'name': 'find_setup', 'label': 'Hunting for a setup', 'args': {}}),
        frame('nous_card', {
          'blocks': [
            {'type': 'heading', 'text': 'XAUUSD BUY from Gold Signals'},
            {'type': 'table', 'cells': [['Entry', '2,650'], ['SL', '2,640'], ['TP1', '2,665']]},
          ],
          'buttons': {'inline_keyboard': [[{'text': 'Place trade', 'callback_data': 'nous:y:s1', 'style': 'success'}, {'text': 'Skip', 'callback_data': 'nous:n:s1', 'style': 'danger'}]]},
        }, feed: 'background', turnId: null, agent: 'nous'),
      ].join()));
      return http.StreamedResponse(controller.stream, 200, headers: {'content-type': 'text/event-stream'});
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
        theme: const CupertinoThemeData(primaryColor: CupertinoColors.systemBlue, scaffoldBackgroundColor: Color(0x00000000), barBackgroundColor: glassBar),
        builder: (context, child) => Stack(fit: StackFit.expand, children: [const Aurora(), ?child]),
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

      final api = DaveApi(base: Uri.parse('https://dave-bot-production.up.railway.app'), token: 't', client: _fakeServer(), streamClient: _fakeChatStream);
      await tester.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const Shell())));
      await _advance(tester);

      // Chat opens first: the stored conversation, then the live turn with its steps.
      await _shot(tester, 'chat_$mode');
      expect(find.text('Should I buy gold now?'), findsOneWidget);
      expect(find.text('Checking price'), findsOneWidget);
      expect(find.text('Hunting for a setup'), findsOneWidget);
      expect(find.text('Stop'), findsOneWidget, reason: 'a turn is running');
      expect(find.text('Place trade'), findsOneWidget, reason: "Nous's card, with its buttons");
      expect(find.text('Resistance'), findsOneWidget, reason: 'the markdown table in the stored reply');
      await tester.tap(find.text('Checking price'));
      await _advance(tester);
      expect(find.textContaining('2651.2'), findsOneWidget, reason: 'a tool row opens to its result');
      await tester.drag(find.byType(ListView).first, const Offset(0, 500));
      await _advance(tester);
      await _shot(tester, 'chat_history_$mode');

      await tester.tap(find.byIcon(CupertinoIcons.chart_bar_square).last);
      await _advance(tester);
      await _shot(tester, 'home_$mode');
      expect(find.text('Dave'), findsWidgets);
      expect(find.textContaining('Volatility 75 Index'), findsOneWidget);

      // Closing a trade asks first, and names the trade.
      await tester.tap(find.textContaining('XAUUSD  Buy'));
      await _advance(tester);
      await _shot(tester, 'close_confirm_$mode');
      expect(find.text('Close trade'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await _advance(tester);

      await tester.drag(find.byType(CustomScrollView).first, const Offset(0, -700));
      await _advance(tester);
      await _shot(tester, 'home_performance_$mode');
      expect(find.text('1M'), findsOneWidget);

      await tester.tap(find.text('1D'));
      await _advance(tester);
      await _shot(tester, 'home_1d_$mode');
      await tester.tap(find.text('1W'));
      await _advance(tester);
      await _shot(tester, 'home_1w_$mode');
      await tester.tap(find.text('1Y'));
      await _advance(tester);
      await _shot(tester, 'home_1y_$mode');

      await tester.tap(find.byIcon(CupertinoIcons.lightbulb).last);
      await _advance(tester);
      await _shot(tester, 'brain_$mode');
      expect(find.textContaining('54% full'), findsOneWidget);
      await tester.drag(find.byType(CustomScrollView).first, const Offset(0, -700));
      await _advance(tester);
      await _shot(tester, 'brain_scrolled_$mode');
      await tester.tap(find.text('Add something about you'));
      await _advance(tester);
      await _shot(tester, 'brain_add_$mode');
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);

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
      expect(find.text('30 pips'), findsOneWidget, reason: 'stop loss summary from the real settings JSON');

      final settingsScroll = find.byType(CustomScrollView).first;
      await tester.drag(settingsScroll, const Offset(0, -650));
      await _advance(tester);
      await _shot(tester, 'settings_2_$mode');
      await tester.drag(settingsScroll, const Offset(0, -650));
      await _advance(tester);
      await _shot(tester, 'settings_3_$mode');

      await tester.tap(find.text('AI providers'));
      await _advance(tester);
      await _shot(tester, 'providers_$mode');
      expect(find.text('Backup 1'), findsOneWidget);
      expect(find.text('Anthropic Claude'), findsOneWidget);
      await tester.tap(find.text('Baseten Model APIs'));
      await _advance(tester);
      await _shot(tester, 'provider_$mode');
      expect(find.text('Baseten 2'), findsOneWidget);
      expect(find.text('Dave\'s main AI'), findsOneWidget);
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);

      await tester.tap(find.text('MetaTrader 5'));
      await _advance(tester);
      await _shot(tester, 'mt5_$mode');
      expect(find.text('VOL_80, BOOM_100, CRASH_500'), findsOneWidget);
      expect(find.text('Use my pair group'), findsOneWidget);
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -500));
      await _advance(tester);
      expect(find.text('1A2B3C4D'), findsOneWidget);
      expect(find.text('Working -- MT5 confirms push is on'), findsOneWidget);
      await _shot(tester, 'mt5_push_$mode');
      expect(find.text('Chart symbol'), findsOneWidget);
      expect(find.text('VOL_80'), findsOneWidget);
      expect(find.text('8s'), findsOneWidget);
      expect(find.text('Change account'), findsOneWidget);
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);

      await tester.tap(find.text('Context & usage'));
      await _advance(tester);
      await _shot(tester, 'context_$mode');
      expect(find.text('Context window'), findsOneWidget);
      expect(find.text('38.6K/164K (23.6%)'), findsOneWidget);
      expect(find.text('Tools'), findsOneWidget);
      expect(find.text('62.4%'), findsOneWidget, reason: 'tools share of the request');
      expect(find.text('4.3%'), findsOneWidget, reason: 'skills share -- small parts still show a real percentage');
      await tester.drag(find.byType(CustomScrollView).first, const Offset(0, -600));
      await _advance(tester);
      await _shot(tester, 'context_today_$mode');
      await tester.drag(find.byType(CustomScrollView).first, const Offset(0, 600));
      await _advance(tester);
      await tester.tap(find.text('Auto-trading').first);
      await _advance(tester);
      await _shot(tester, 'context_auto_$mode');
      expect(find.textContaining('No auto-trading cycle recorded yet'), findsOneWidget);
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);

      await tester.tap(find.text('Self-aware alerts'));
      await _advance(tester);
      await _shot(tester, 'alerts_$mode');
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);

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
