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
import 'package:dave_mobile/screens/extras.dart';
import 'package:dave_mobile/screens/growth.dart';
import 'package:dave_mobile/screens/history.dart';
import 'package:dave_mobile/screens/voice.dart';
import 'package:dave_mobile/screens/dave_voice.dart';
import 'package:dave_mobile/widgets/setup_drawing.dart';
import 'package:dave_mobile/widgets/money_rain.dart';
import 'package:dave_mobile/screens/connect.dart';
import 'package:dave_mobile/screens/shell.dart';
import 'package:dave_mobile/look.dart';
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
        case '/api/app/voice' when req.method == 'POST':
          body = {
            'voices': [
              {'voiceId': 'fish-mine', 'name': 'Dave (my clone)', 'mine': true},
              {'voiceId': 'e58b0d7efca34eb38d5c4985e378abcb', 'name': 'Calm narrator', 'mine': false},
              {'voiceId': '7f92f8afb8ec43bf81429cc1c9199cb1', 'name': 'Energetic trader', 'mine': false},
              {'voiceId': '54a5170264694bfc8e9ad98df7bd89c3', 'name': 'Deep British', 'mine': false},
            ],
          };
        case '/api/app/voice':
          body = {
            'enabled': true,
            'activeProvider': 'fish-audio',
            'providers': [
              {'id': 'elevenlabs', 'name': 'ElevenLabs', 'about': 'Most natural voices; clone your own.', 'link': 'https://elevenlabs.io/app/settings/api-keys', 'key': 'sk_1************************9f2a', 'voiceId': 'JBFqnCBsd6RMkjVDRZzb'},
              {'id': 'fish-audio', 'name': 'Fish Audio', 'about': 'Cheaper, huge public voice library, good cloning.', 'link': 'https://fish.audio/app/api-keys', 'key': 'a8d3********************77c1', 'voiceId': 'fish-mine'},
            ],
            'geminiLive': {'key': null, 'link': 'https://aistudio.google.com/app/apikey'},
            'speechToText': {'key': 'gsk_****************a1b2', 'count': 1, 'link': 'https://console.groq.com/keys'},
          };
        case '/api/app/history':
          final rnd = Random(7);
          final now = DateTime(2026, 9, 28, 12).millisecondsSinceEpoch;
          final syms = ['XAUUSD', 'BOOM_1000', 'EURUSD', 'VOL_75', 'GBPUSD'];
          final trades = [
            for (var i = 0; i < 40; i++)
              {
                'ticket': '${7000 + i}',
                'symbol': syms[i % syms.length],
                'side': i.isEven ? 'buy' : 'sell',
                'pnl': double.parse(((rnd.nextDouble() < 0.58 ? 1 : -0.6) * (6 + rnd.nextDouble() * 20)).toStringAsFixed(2)),
                'closedAt': now - (40 - i) * 17 * 3600 * 1000,
                'closedBy': ['tp', 'sl', 'dave', 'manual'][i % 4],
                if (i % 3 == 0) 'why': {'reason': 'H1 demand held, M15 bullish engulfing', 'entry': 2650.2, 'sl': 2644, 'tp': 2668},
              },
          ];
          body = {
            'summary': {'trades': 40, 'wins': 23, 'losses': 17, 'winRatePercent': 58, 'netPnl': 142.3, 'profitFactor': 1.84, 'bestTrade': 25.9, 'worstTrade': -15.5, 'avgWin': 14.2, 'avgLoss': -8.9},
            'bySymbol': [
              {'symbol': 'XAUUSD', 'trades': 8, 'pnl': 71.2, 'winRatePercent': 75},
              {'symbol': 'BOOM_1000', 'trades': 8, 'pnl': 44.5, 'winRatePercent': 62},
              {'symbol': 'EURUSD', 'trades': 8, 'pnl': 20.1, 'winRatePercent': 50},
              {'symbol': 'VOL_75', 'trades': 8, 'pnl': -12.4, 'winRatePercent': 38},
            ],
            'trades': trades,
            'truncated': false,
          };
        case '/api/app/growth':
          body = jsonDecode(File('test/fixtures/growth.json').readAsStringSync());
        case '/api/app/dashboard':
          body = _dashboard();
        case '/api/app/brain':
          final kid = req.url.queryParameters['knowledgeId'];
          body = kid == null ? _brain : {'id': kid, 'title': 'V75 fakes the first London breakout', 'useWhen': 'A London-open breakout on V75 with no retest', 'content': 'The first push out of the Asian range on V75 reverses more often than not.', 'createdAt': 0};
        case '/api/app/settings':
          body = jsonDecode(File('test/fixtures/settings.json').readAsStringSync());
        case '/api/app/provider' when req.method == 'POST' && req.body.contains('"models"'):
          body = {'models': ['deepseek-ai/DeepSeek-V3.2', 'deepseek-ai/DeepSeek-R1', 'moonshotai/Kimi-K2-Instruct', 'openai/gpt-oss-120b', 'Qwen/Qwen3-235B-A22B', 'zai-org/GLM-4.6']};
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
            'accountName': 'David Inyang',
            'accounts': [
              {'login': '40123456', 'server': 'Deriv-Demo', 'name': 'David Inyang', 'active': true},
              {'login': '51009988', 'server': 'Headway-Real', 'name': null, 'active': false},
            ],
            'summary': 'MT5 is running and logged in (40123456 on Deriv-Demo, chart VOL_80 M1). The EA last reported 3s ago.',
            'status': {
              'installed': true, 'compiled': true, 'running': true, 'login': 'logged-in', 'configured': true,
              'account': {'login': '40123456', 'server': 'Deriv-Demo', 'symbol': 'VOL_80', 'period': 'M1'},
              'inputs': {'PushSeconds': 8, 'MagicNumber': 20260101, 'SlippagePoints': 30, 'EnablePush': 'true', 'EnableEmail': 'false', 'SwingLookback': 50, 'ZoneMax': 6, 'EqTolerancePips': 1.5},
              'marketWatch': ['VOL_80', 'BOOM_100', 'CRASH_500'],
              'metaquotesIds': ['1A2B3C4D'],
              'phonePush': {'state': 'on', 'detail': null, 'eaReports': true},
              'relay': {'count': 1200, 'errors': 0, 'lastAt': DateTime.now().millisecondsSinceEpoch / 1000 - 3, 'lastStatus': 200},
            },
          };
        case '/api/app/watchlist':
          body = {
            'setups': [
              {'id': 's1', 'symbol': 'XAUUSD', 'reason': 'Sweep the Asian high, then buy the retest', 'plan': 'XAUUSD: ✓ above 2660 → below 2650, then BUY SL 2641 TP 2672; cancel if below 2640', 'status': 'active', 'stage': 1, 'steps': 2, 'outcome': null, 'expiresAt': DateTime.now().millisecondsSinceEpoch + 5 * 3600000},
              {'id': 's0', 'symbol': 'BOOM_1000', 'reason': 'Spike catch', 'plan': 'BOOM_1000: ✓ below 10480, then BUY', 'status': 'placed', 'stage': 1, 'steps': 1, 'outcome': 'Placed #88123', 'expiresAt': DateTime.now().millisecondsSinceEpoch},
            ],
            'reminders': [
              {'id': 'r1', 'text': 'Check the London open on EURUSD', 'reason': 'NY range break', 'symbol': 'EURUSD', 'dueAt': DateTime.now().millisecondsSinceEpoch + 90 * 60000},
            ],
            'levels': [
              {'id': 'w1', 'symbol': 'XAUUSD', 'kind': 'price_at_or_below', 'level': 2645.5, 'reason': 'Demand zone -- buy the tap', 'createdAt': DateTime.now().millisecondsSinceEpoch},
            ],
            'checks': [],
          };
        case '/api/app/prompt':
          body = {
            'parts': [
              {'file': 'SOUL.md', 'title': 'Personality', 'about': 'Who Dave is and how he talks', 'custom': false, 'text': '# Soul\n\nYou are Dave.'},
              {'file': 'trading.md', 'title': 'Trading', 'about': 'How Dave trades', 'custom': true, 'text': '# Trading\n\nWhen the trader tells you to trade, you trade.'},
            ],
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
        case '/api/app/nous/state':
          body = {
            'loggedIn': true,
            'account': 'Dave Trader (@davetrader)',
            'listening': true,
            'running': true,
            'chats': [
              {'id': '-1001', 'title': 'Gold Signals VIP', 'kind': 'channel'},
              {'id': '-1002', 'title': 'FX Room', 'kind': 'group'},
            ],
            'autoApprove': false,
            'lots': 0.05,
            'lotsAuto': false,
            'maxAgeMinutes': 5,
            'trades': [
              {'ticket': '881', 'symbol': 'XAUUSD', 'side': 'buy', 'lots': 0.05, 'entry': 2650, 'sl': 2640, 'tp1': 2665, 'tp2': 2680, 'from': 'Gold Signals VIP'},
            ],
            'signals': [
              {'id': 's1', 'symbol': 'XAUUSD', 'side': 'buy', 'from': 'Gold Signals VIP', 'postedAt': DateTime.now().millisecondsSinceEpoch - 600000, 'status': 'placed'},
              {'id': 's2', 'symbol': 'GBPJPY', 'side': 'sell', 'from': 'FX Room', 'postedAt': DateTime.now().millisecondsSinceEpoch - 3600000, 'status': 'expired'},
            ],
          };
        case '/api/app/nous/chats':
          body = {
            'chats': [
              {'id': '-1001', 'title': 'Gold Signals VIP', 'kind': 'channel', 'picked': true},
              {'id': '-1002', 'title': 'FX Room', 'kind': 'group', 'picked': true},
              {'id': '-1003', 'title': 'Crypto Calls', 'kind': 'channel', 'picked': false},
            ],
          };
        case '/api/app/keys':
          body = {
            'e2b': {'title': 'E2B', 'about': 'Lets Dave run real scripts.', 'link': 'https://e2b.dev/dashboard', 'keys': [{'id': 'k1', 'label': 'Main', 'key': 'e2b_…9f2a'}]},
            'firecrawl': {'title': 'Firecrawl', 'about': 'Lets Dave read web pages.', 'link': 'https://firecrawl.dev', 'keys': []},
          };
        case '/api/app/pair-groups':
          body = {
            'groups': [
              {'id': 'synthetic', 'name': 'Synthetic', 'symbols': ['BOOM_1000', 'CRASH_1000', 'VOL_75', 'VOL_100', 'STEP_INDEX']},
              {'id': 'forex', 'name': 'Forex', 'symbols': ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD']},
              {'id': 'crypto', 'name': 'Crypto', 'symbols': ['BTCUSD', 'ETHUSD']},
              {'id': 'metals', 'name': 'Metals', 'symbols': ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD']},
            ],
            'activeGroupId': 'synthetic',
            'fallbackGroupId': 'forex',
          };
        case '/api/app/analysis-scope':
          body = {
            'mode': 'custom',
            'timeframes': ['H4', 'H1', 'M15'],
            'endpoints': ['trend', 'structure', 'zones', 'liquidity'],
            'allTimeframes': ['D1', 'H4', 'H1', 'M15', 'M5', 'M3', 'M1'],
            'allEndpoints': ['trend', 'momentum', 'structure', 'zones', 'liquidity', 'candles', 'ict', 'order_blocks'],
          };
        case '/api/app/chat/activity/range':
          final now = DateTime.now().millisecondsSinceEpoch;
          body = {
            'total': 3,
            'events': [
              {'id': 90, 'at': now - 3600000, 'feed': 'background', 'kind': 'self_aware', 'data': {'text': 'VOL_75 BUY has been losing for 10 min -- still inside the plan, stop at 402,100.'}},
              {'id': 89, 'at': now - 7200000, 'feed': 'loop', 'kind': 'ea_request', 'data': {'endpoint': 'candles', 'symbol': 'XAUUSD', 'timeframe': 'M5', 'ok': true, 'ms': 1400}},
              {'id': 88, 'at': now - 86400000 * 3, 'feed': 'loop', 'kind': 'log', 'data': {'text': 'STORM_200: SELL_LIMIT levels refused (risk:reward is 1.56:1) -- sending it back once to fix the stop/target'}},
            ],
          };
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
        frame('file', {'id': 'ab12cd34ef567890', 'name': 'gold-backtest.csv', 'bytes': 48213, 'mime': 'text/csv', 'caption': 'Last 90 days of the pullback setup'}),
        frame('thinking', {'text': 'The trader wants an entry. Check price and structure first.'}),
        frame('tool_start', {'id': 't', 'name': 'update_todos', 'label': 'To-do list', 'args': {}}),
        frame('tool_end', {'id': 't', 'name': 'update_todos', 'label': 'To-do list', 'ms': 3, 'result': {
          'todos': [
            {'id': '1', 'text': 'Check the gold price', 'status': 'done', 'note': '2,651.2'},
            {'id': '2', 'text': 'Find a setup on gold', 'status': 'in_progress'},
            {'id': '3', 'text': "Today's P&L", 'status': 'pending'},
          ],
        }}),
        frame('tool_start', {'id': 'a', 'name': 'get_price', 'label': 'Checking price', 'args': {'symbol': 'XAUUSD'}}),
        frame('tool_end', {'id': 'a', 'name': 'get_price', 'label': 'Checking price', 'result': {'bid': 2651.2}, 'ms': 420}),
        frame('text', {'text': 'Price is 2,651. Looking for structure.'}),
        frame('tool_start', {'id': 'b', 'name': 'find_setup', 'label': 'Hunting for a setup', 'args': {}}),
        frame('decision', {'symbol': 'XAUUSD', 'action': 'BUY_LIMIT', 'reason': 'Sweep of the Asian low, limit on the order block at 2,648'}, feed: 'loop', turnId: null),
        frame('analysis', {'symbol': 'XAUUSD', 'timeframes': ['M1', 'M5', 'H1'], 'stage': 'reading'}, feed: 'loop', turnId: null),
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

/// The app as main.dart builds it, in one of the two looks.
Widget _app(Widget home, {Look look = Look.midnightLime}) {
  final controller = LookController(look);
  return RepaintBoundary(
    key: _frameKey,
    child: LookScope(
      controller: controller,
      child: CupertinoApp(
        debugShowCheckedModeBanner: false,
        theme: CupertinoThemeData(brightness: look.brightness, primaryColor: look.accent, scaffoldBackgroundColor: const Color(0x00000000), barBackgroundColor: look.base.withValues(alpha: 0.82)),
        builder: (context, child) => Stack(fit: StackFit.expand, children: [const Aurora(), ?child]),
        home: home,
      ),
    ),
  );
}

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
      await tester.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const Shell()), look: brightness == Brightness.dark ? Look.midnightLime : Look.pearl));
      await _advance(tester);

      // Home opens first: the purple balance hero with its round buttons.
      await _shot(tester, 'home_$mode');
      // A trade hits its take profit: money rain over the app, then it clears itself.
      tester.state<MoneyRainState>(find.byType(MoneyRain)).celebrate(pnl: 12.4, symbol: 'XAUUSD');
      await tester.pump(const Duration(milliseconds: 900));
      await _shot(tester, 'money_rain_$mode');
      await tester.pump(const Duration(milliseconds: 700));
      await _shot(tester, 'money_rain_b_$mode');
      final banner = find.byKey(const ValueKey('money-rain-banner'));
      expect(find.descendant(of: banner, matching: find.text('+\$12.40')), findsOneWidget, reason: 'the profit on the banner');
      expect(find.descendant(of: banner, matching: find.text('XAUUSD hit take profit')), findsOneWidget);
      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byKey(const ValueKey('money-rain-banner')), findsNothing, reason: 'gone after a few seconds');
      expect(find.textContaining('MT5 live'), findsOneWidget);
      expect(find.text(brightness == Brightness.dark ? 'Win rate' : 'TOTAL BALANCE'), findsOneWidget, reason: 'Lime has the tile grid, Pearl the editorial numbers');

      // Live: what Dave is analysing right now.
      await tester.tap(find.byIcon(CupertinoIcons.waveform_path_ecg).last);
      await _advance(tester);
      await _shot(tester, 'live_$mode');
      expect(find.text('Analysing XAUUSD'), findsWidgets);
      expect(find.text('BUY LIMIT XAUUSD'), findsOneWidget);
      // Every row opens with its full reason.
      await tester.tap(find.text('BUY LIMIT XAUUSD'));
      await _advance(tester);
      await _shot(tester, 'live_detail_$mode');
      expect(find.text('Copy'), findsOneWidget);
      await tester.tap(find.text('Copy'));
      await _advance(tester);
      // Older history by period: self-aware alerts, MT5 data requests and the loop's own log.
      await tester.tap(find.byKey(const ValueKey('live-period')));
      await _advance(tester);
      await tester.tap(find.text('Last 3 weeks'));
      await _advance(tester);
      await _shot(tester, 'live_3weeks_$mode');
      expect(find.text('Self-aware'), findsOneWidget);
      expect(find.text('MT5 · candles XAUUSD M5'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('live-period')));
      await _advance(tester);
      await tester.tap(find.text('Live -- as it happens'));
      await _advance(tester);

      await tester.tap(find.byIcon(CupertinoIcons.chat_bubble_2).last);
      await _advance(tester);
      // Chat: the stored conversation, then the live turn with its steps.
      await _shot(tester, 'chat_$mode');
      expect(find.text('gold-backtest.csv'), findsOneWidget, reason: 'a file Dave sent shows as a card');
      expect(find.text('Checking price'), findsOneWidget);
      expect(find.text('Hunting for a setup'), findsOneWidget);
      expect(find.text('Stop'), findsOneWidget, reason: 'a turn is running');
      expect(find.text('Place trade'), findsOneWidget, reason: "Nous's card, with its buttons");
      final rowBefore = tester.getTopLeft(find.text('Checking price'));
      await tester.tap(find.text('Checking price'));
      await _advance(tester);
      expect(find.textContaining('2651.2'), findsOneWidget, reason: 'a tool row opens to its result');
      expect(tester.getTopLeft(find.text('Checking price')).dy, closeTo(rowBefore.dy, 1), reason: 'opening a step keeps it in place');
      await tester.tap(find.text('Checking price'));
      await _advance(tester);
      expect(tester.getTopLeft(find.text('Checking price')).dy, closeTo(rowBefore.dy, 1), reason: 'closing it does not jump the chat');
      await tester.tap(find.text('Checking price'));
      await _advance(tester);
      await tester.drag(find.byType(ListView).first, const Offset(0, 500));
      await _advance(tester);
      await _shot(tester, 'chat_history_$mode');
      // The stored conversation, above the live turn (the to-do card pushes it up).
      for (var i = 0; i < 8 && find.text('Resistance').evaluate().isEmpty; i++) {
        await tester.dragFrom(const Offset(200, 350), const Offset(0, 400));
        await _advance(tester);
      }
      expect(find.text('Listen'), findsWidgets, reason: 'replies can be read aloud');
      expect(find.text('Resistance'), findsOneWidget, reason: 'the markdown table in the stored reply');
      await tester.tap(find.text('DeepSeek-V3.2').first);
      await _advance(tester);
      await _shot(tester, 'ai_switcher_$mode');
      expect(find.byKey(const ValueKey('ai-palette')), findsOneWidget);
      expect(find.text('IN USE'), findsOneWidget);
      await tester.tap(find.byIcon(CupertinoIcons.xmark).last);
      await _advance(tester);

      // Chat is full screen: no tab bar, a back button instead.
      expect(find.byIcon(CupertinoIcons.gear_alt), findsNothing);
      expect(find.textContaining('SL 30 pips'), findsOneWidget, reason: 'stop loss chip in the chat');
      await tester.tap(find.text('Home').first);
      await _advance(tester);
      expect(find.text('Dave'), findsWidgets);
      expect(find.textContaining('Volatility 75 Index'), findsOneWidget);

      // Closing a trade asks first, and names the trade.
      await tester.dragUntilVisible(find.textContaining('XAUUSD  Buy'), find.byType(CustomScrollView).first, const Offset(0, -200));
      await _advance(tester);
      await tester.tap(find.textContaining('XAUUSD  Buy'));
      await _advance(tester);
      // Tapping a trade opens its card: SL and TP edited in place, breakeven, close.
      await _shot(tester, 'trade_sheet_$mode');
      expect(find.text('Stop loss'), findsOneWidget);
      expect(find.text('Take profit'), findsOneWidget);
      expect(find.text('Save SL / TP'), findsOneWidget);
      await tester.tap(find.text('Breakeven'));
      await _advance(tester);
      await _shot(tester, 'trade_sheet_breakeven_$mode');
      // Closing still asks first, and names the trade.
      await tester.tap(find.text('Close trade'));
      await _advance(tester);
      await _shot(tester, 'close_confirm_$mode');
      expect(find.text('Close trade'), findsWidgets);
      await tester.tap(find.text('Cancel').last); // the dialog's, not a pending order's Cancel button
      await _advance(tester);
      await tester.tapAt(const Offset(20, 40)); // dismiss the card
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
      expect(find.text('Dave is trading'), findsOneWidget, reason: 'the trading switch leads Settings');
      Future<void> open(String row) async {
        await tester.scrollUntilVisible(find.text(row), 200, scrollable: find.byType(Scrollable).first);
        await _advance(tester);
        await tester.tap(find.text(row));
        await _advance(tester);
      }

      Future<void> back() async {
        await tester.tap(find.byType(CupertinoNavigationBarBackButton).last);
        await _advance(tester);
      }

      await open('Trading & markets');
      await _shot(tester, 'settings_trading_$mode');
      expect(find.text('Autonomous trading'), findsOneWidget);
      expect(find.text('5 min'), findsOneWidget);
      await open('Pair groups');
      await _shot(tester, 'pair_groups_$mode');
      expect(find.text('Synthetic'), findsNWidgets(2), reason: 'shown as the main group and in the list');
      expect(find.text('Backup group'), findsOneWidget, reason: 'the backup group has its own clear row');
      await back();
      await open('What Dave analyses');
      await _shot(tester, 'analysis_scope_$mode');
      expect(find.text('H4'), findsOneWidget);
      await back();
      await back();

      await open('Risk');
      await _shot(tester, 'settings_risk_$mode');
      expect(find.text('Dave decides'), findsNWidgets(3), reason: 'SL, TP and lots each have their inline Off / Fixed / Dave decides control');
      expect(find.text('30'), findsWidgets, reason: 'the fixed stop loss from the real settings JSON, editable in place');
      expect(find.text('1:1'), findsOneWidget, reason: 'min reward shown as a typed value');
      await back();

      await open('How Dave behaves');
      await _shot(tester, 'settings_behaviour_$mode');
      expect(find.byKey(const ValueKey('thinking-effort')), findsOneWidget, reason: 'the effort picker shows while deeper thinking is on');
      expect(find.text('Draw my trades'), findsOneWidget, reason: 'the switch for auto-drawn trades');
      expect(find.textContaining('Up to 10 steps through a checklist'), findsOneWidget);
      await back();

      for (var i = 0; i < 6 && find.text('Alerts & notifications').hitTestable().evaluate().isEmpty; i++) {
        await tester.dragFrom(const Offset(200, 600), const Offset(0, -300));
        await _advance(tester);
      }
      await tester.tap(find.text('Alerts & notifications'));
      await _advance(tester);
      await _shot(tester, 'settings_alerts_$mode');
      expect(find.byKey(const ValueKey('self-aware-mode')), findsOneWidget, reason: 'the self-aware review mode picker');
      expect(find.textContaining('tells you what he\'d do'), findsOneWidget, reason: 'advise is the default');
      expect(find.text('50 · 60 · 75 · 89 · 95%'), findsOneWidget, reason: 'the five stop-loss warning rows at a glance');
      await tester.tap(find.byKey(const ValueKey('sl-ladder')));
      await _advance(tester);
      await _shot(tester, 'sl_ladder_$mode');
      expect(find.text('Deep loss'), findsOneWidget);
      expect(find.text('Warning 5'), findsOneWidget, reason: 'five rows');
      expect(find.text('74%'), findsNothing);
      expect(find.byKey(const ValueKey('sl-add')), findsOneWidget, reason: 'rows can be added');
      expect(find.byKey(const ValueKey('sl-delete-2')), findsOneWidget, reason: '...and deleted');
      await back();
      await back();

      await open('AI & models');
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
      await back();
      await back();
      await back();

      await open('Service keys');
      await _shot(tester, 'service_keys_$mode');
      expect(find.text('Add E2B key'), findsOneWidget);
      expect(find.text('Add Firecrawl key'), findsOneWidget);
      await back();

      await tester.scrollUntilVisible(find.text('MetaTrader 5'), -200, scrollable: find.byType(Scrollable).first);
      await _advance(tester);
      await tester.tap(find.text('MetaTrader 5'));
      await _advance(tester);
      await _shot(tester, 'mt5_$mode');
      expect(find.text('Account 51009988'), findsOneWidget, reason: 'a saved account to switch to');
      await tester.dragUntilVisible(find.text('VOL_80, BOOM_100, CRASH_500'), find.byType(CustomScrollView).last, const Offset(0, -200));
      await _advance(tester);
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
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);

      await open('Nous copy trading');
      await _shot(tester, 'nous_$mode');
      expect(find.text('Dave Trader (@davetrader)'), findsOneWidget);
      expect(find.text('Live'), findsOneWidget);
      expect(find.text('0.05'), findsOneWidget);
      await tester.tap(find.text('Channels & groups'));
      await _advance(tester);
      await _shot(tester, 'nous_channels_$mode');
      expect(find.text('Crypto Calls'), findsOneWidget);
      expect(find.text('2 PICKED'), findsOneWidget);
      await tester.tap(find.text('Crypto Calls'));
      await _advance(tester);
      expect(find.text('3 PICKED'), findsOneWidget);
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);
      await tester.tap(find.text('Reconnect Telegram'));
      await _advance(tester);
      await _shot(tester, 'nous_connect_$mode');
      expect(find.text('Send me the code'), findsOneWidget);
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);

      await tester.scrollUntilVisible(find.text('Context & usage'), -200, scrollable: find.byType(Scrollable).first);
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

      await open('Alerts & notifications');
      await tester.tap(find.text('Self-aware alerts'));
      await _advance(tester);
      await _shot(tester, 'alerts_$mode');
      await back();
      await back();

      await tester.pumpWidget(const SizedBox()); // dispose, cancelling the dashboard's refresh timer
    });

    testWidgets('waiting on, prompt and EA settings render ($mode)', (tester) async {
      tester.view.physicalSize = const Size(1080, 2340);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 72, bottom: 48);
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      final api = DaveApi(base: Uri.parse('https://dave-bot-production.up.railway.app'), token: 't', client: _fakeServer(), streamClient: _fakeChatStream);
      final look = brightness == Brightness.dark ? Look.midnightLime : Look.pearl;

      await tester.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const WatchlistPage()), look: look));
      await _advance(tester);
      await _shot(tester, 'waiting_on_$mode');
      expect(find.textContaining('XAUUSD: ✓ above 2660'), findsOneWidget);
      expect(find.text('Check the London open on EURUSD'), findsOneWidget);
      expect(find.text('XAUUSD ≤ 2645.5'), findsOneWidget);

      await tester.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const PromptPage()), look: look));
      await _advance(tester);
      await _shot(tester, 'prompt_$mode');
      expect(find.text('Personality'), findsOneWidget);
      expect(find.text('Reset Trading'), findsOneWidget);

      await tester.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const EaSettingsPage()), look: look));
      await _advance(tester);
      await _shot(tester, 'ea_settings_$mode');
      expect(find.text('20260101'), findsOneWidget);
      expect(find.text('Magic number'), findsOneWidget);

      // Dave's drawing board, as it appears in chat.
      final cs = [
        [2648, 2652, 2646, 2651], [2651, 2655, 2650, 2654], [2654, 2658, 2653, 2657], [2657, 2660, 2655, 2656], [2656, 2659, 2652, 2653],
        [2653, 2656, 2651, 2655], [2655, 2661, 2654, 2660], [2660, 2664, 2659, 2663], [2663, 2667, 2662, 2662.5],
      ];
      final proj = [[2662.5, 2668, 2661, 2667], [2667, 2667.5, 2658, 2659], [2659, 2660, 2651, 2652], [2652, 2653, 2645, 2646]];
      await tester.pumpWidget(_app(
        AppScope(
          api: api,
          onUnpaired: (_) async {},
          child: CupertinoPageScaffold(
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: SetupDrawingView(drawing: {
                  'title': 'Sweep of the Asian high, then short',
                  'symbol': 'XAUUSD',
                  'timeframe': 'M15',
                  'candles': [
                    for (final c in cs) {'o': c[0], 'h': c[1], 'l': c[2], 'c': c[3]},
                    for (final c in proj) {'o': c[0], 'h': c[1], 'l': c[2], 'c': c[3], 'projected': true},
                  ],
                  'lines': [
                    {'price': 2666, 'kind': 'entry', 'label': 'SELL LIMIT'},
                    {'price': 2671, 'kind': 'sl', 'label': 'SL'},
                    {'price': 2646, 'kind': 'tp', 'label': 'TP'},
                  ],
                  'zones': [{'from': 2663, 'to': 2668, 'kind': 'supply', 'label': 'Asian high', 'fromIndex': 6}],
                  'arrows': [{'fromIndex': 9, 'fromPrice': 2668, 'toIndex': 12, 'toPrice': 2647, 'label': 'reversal'}],
                  'notes': [{'index': 9, 'price': 2668.5, 'text': 'sweep'}],
                  'caption': 'Wait for the wick above 2,665, then sell the rejection.',
                }),
              ),
            ),
          ),
        ),
        look: look,
      ));
      await _advance(tester);
      await _shot(tester, 'drawing_$mode');
      expect(find.text('Sweep of the Asian high, then short'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('drawing-open')));
      await _advance(tester);
      await _shot(tester, 'drawing_rotated_$mode');
      expect(find.byType(RotatedBox), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('drawing-rotate')));
      await _advance(tester);
      expect(tester.widget<RotatedBox>(find.byType(RotatedBox)).quarterTurns, 2);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('trade history renders ($mode)', (tester) async {
      tester.view.physicalSize = const Size(1080, 2340);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 72, bottom: 48);
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      final api = DaveApi(base: Uri.parse('https://dave-bot-production.up.railway.app'), token: 't', client: _fakeServer(), streamClient: _fakeChatStream);
      final look = brightness == Brightness.dark ? Look.midnightLime : Look.pearl;
      await tester.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const HistoryScreen()), look: look));
      await _advance(tester);
      await _shot(tester, 'history_$mode');
      expect(find.text('40 trades'.toUpperCase()).evaluate().isNotEmpty || find.text('40 trades').evaluate().isNotEmpty, true);
      await tester.tap(find.byKey(const ValueKey('range-custom')));
      await _advance(tester);
      await _shot(tester, 'history_custom_$mode');
      await tester.tap(find.text('Show'));
      await _advance(tester);
      await tester.drag(find.byType(CustomScrollView).first, const Offset(0, -900));
      await _advance(tester);
      await _shot(tester, 'history_list_$mode');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('voice screens render ($mode)', (tester) async {
      tester.view.physicalSize = const Size(1080, 2340);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 72, bottom: 48);
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      final look = brightness == Brightness.dark ? Look.midnightLime : Look.pearl;
      Future<void> shot(String name, VoiceSession s) async {
        await tester.pumpWidget(_app(VoiceScreen(session: s), look: look));
        for (var i = 0; i < 6; i++) {
          await tester.pump(const Duration(milliseconds: 90));
        }
        await _shot(tester, '${name}_$mode');
      }

      const model = 'Gemini 3.8 Live';
      await shot('voice_listening', const VoiceSession(
        phase: VoicePhase.listening, model: model, elapsed: Duration(minutes: 1, seconds: 12), level: 0.6,
        lines: [
          VoiceLine(me: false, text: "Hey -- I'm here. Gold is quiet, one trade open."),
          VoiceLine(me: true, text: "How's my gold trade doing, and should I move it to", partial: true),
        ],
      ));
      await shot('voice_thinking', const VoiceSession(
        phase: VoicePhase.thinking, model: model, thinkingLevel: 'high', elapsed: Duration(minutes: 1, seconds: 20),
        thoughts: [
          'Ticket #501 XAUUSD buy, entry 2600, stop 2580 -- that is 1R = 20.',
          'Price 2630 is +1.5R. Breakeven is allowed and the goal card says protect winners.',
          'Check M15 volatility before suggesting it -- a spike could tag 2600.',
        ],
        lines: [VoiceLine(me: true, text: "How's my gold trade doing, and should I move it to breakeven?")],
      ));
      await shot('voice_tools', const VoiceSession(
        phase: VoicePhase.tools, model: model, thinkingLevel: 'high', elapsed: Duration(minutes: 1, seconds: 26), level: 0.3,
        tools: [
          VoiceTool(icon: CupertinoIcons.chart_bar_alt_fill, label: 'Open positions', state: ToolRun.done, result: '#501 XAUUSD +\$29.80', ms: 400),
          VoiceTool(icon: CupertinoIcons.graph_square, label: 'Candles XAUUSD M15', state: ToolRun.running),
          VoiceTool(icon: CupertinoIcons.waveform_path, label: 'Volatility XAUUSD M15', state: ToolRun.running),
          VoiceTool(icon: CupertinoIcons.lightbulb, label: 'Brain: volatility neuron', state: ToolRun.done, result: '2 facts', ms: 120),
        ],
        lines: [VoiceLine(me: false, text: "Let me pull the fresh candles and the volatility at the same time", partial: true)],
      ));
      await shot('voice_speaking', const VoiceSession(
        phase: VoicePhase.speaking, model: model, thinkingLevel: 'high', elapsed: Duration(minutes: 1, seconds: 41), level: 0.85,
        tools: [
          VoiceTool(icon: CupertinoIcons.graph_square, label: 'Candles XAUUSD M15', state: ToolRun.done, result: 'higher lows', ms: 2100),
          VoiceTool(icon: CupertinoIcons.waveform_path, label: 'Volatility XAUUSD M15', state: ToolRun.done, result: 'ATR 6.1', ms: 1800),
        ],
        lines: [
          VoiceLine(me: true, text: "How's my gold trade doing, and should I move it to breakeven?"),
          VoiceLine(me: false, text: "You're up 1.5R, about \$30. M15 is still making higher lows and ATR is only 6 -- a breakeven stop at 2600 is 30 points away, so it's safe to", partial: true),
        ],
      ));
      await shot('voice_confirm', const VoiceSession(
        phase: VoicePhase.confirm, model: model, elapsed: Duration(minutes: 1, seconds: 55),
        confirm: VoiceConfirm(title: 'Move #501 XAUUSD to breakeven', detail: 'Stop 2580.00 → 2600.00 (entry). Price now 2630.10.', risk: 'Worst case after this: \$0.00 instead of -\$20.00.'),
      ));
      expect(find.text('Yes, do it'), findsOneWidget);
      await shot('voice_limit', const VoiceSession(
        phase: VoicePhase.listening, model: model, elapsed: Duration(minutes: 13, seconds: 40), level: 0.2, muted: true, chartShared: true,
        lines: [VoiceLine(me: false, text: "Done -- #501 is at breakeven. I'll tell you if it gets near 2650.")],
      ));
      await tester.pumpWidget(_app(const CupertinoPageScaffold(child: Align(alignment: Alignment.bottomCenter, child: VoiceSettingsSheet())), look: look));
      await tester.pump(const Duration(milliseconds: 200));
      await _shot(tester, 'voice_settings_$mode');
      await tester.pumpWidget(_app(const CupertinoPageScaffold(child: Align(alignment: Alignment.bottomCenter, child: VoiceSettingsSheet(options: LiveOptions(thinking: true, voice: 'Aoede', allowActions: false)))), look: look));
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.text('Changes apply from your next call.'), findsOneWidget);
      await _shot(tester, 'voice_settings_deep_$mode');
      final api = DaveApi(base: Uri.parse('https://dave-bot-production.up.railway.app'), token: 't', client: _fakeServer(), streamClient: _fakeChatStream);
      await tester.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const DaveVoicePage()), look: look));
      await _advance(tester);
      await _shot(tester, 'dave_voice_$mode');
      expect(find.text('LEADS'), findsOneWidget);
      await tester.dragUntilVisible(find.byKey(const ValueKey('gemini-live-card')), find.byType(Scrollable).first, const Offset(0, -300));
      await _advance(tester);
      await _shot(tester, 'dave_voice_gemini_$mode');
      expect(find.text('Gemini API key'), findsOneWidget, reason: 'a place for the Gemini Live key');
      expect(find.text('Groq API key'), findsOneWidget, reason: 'speech to text for talking to Dave');
      expect(find.text('gsk_****************a1b2'), findsOneWidget, reason: 'shown masked');
      expect(find.text('Not added'), findsOneWidget);
      await tester.tap(find.text('fish-mine'));
      await _advance(tester);
      await _shot(tester, 'dave_voice_picker_$mode');
      expect(find.text('Dave (my clone)'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('growth screen renders ($mode)', (tester) async {
      tester.view.physicalSize = const Size(1080, 2340);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 72, bottom: 48);
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      final api = DaveApi(base: Uri.parse('https://dave-bot-production.up.railway.app'), token: 't', client: _fakeServer(), streamClient: _fakeChatStream);
      final look = brightness == Brightness.dark ? Look.midnightLime : Look.pearl;

      await tester.pumpWidget(_app(AppScope(api: api, onUnpaired: (_) async {}, child: const GrowthScreen()), look: look));
      await _advance(tester);
      await _shot(tester, 'growth_$mode');
      expect(find.text('v04'), findsWidgets);
      expect(find.text('Reflect now'), findsOneWidget);
      await tester.drag(find.byType(CustomScrollView).first, const Offset(0, -900));
      await _advance(tester);
      await _shot(tester, 'growth_goal_$mode');
      await tester.drag(find.byType(CustomScrollView).first, const Offset(0, -700));
      await _advance(tester);
      await _shot(tester, 'growth_neurons_$mode');
      await tester.tap(find.byKey(const ValueKey('neuron-synthetic')));
      await _advance(tester);
      await _shot(tester, 'growth_neuron_$mode');
      expect(find.textContaining('Boom 1000 spikes cluster'), findsOneWidget);
      await tester.tap(find.byType(CupertinoNavigationBarBackButton));
      await _advance(tester);
      await tester.drag(find.byType(CustomScrollView).first, const Offset(0, -1400));
      await _advance(tester);
      await _shot(tester, 'growth_versions_$mode');
      await tester.pumpWidget(const SizedBox());
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
