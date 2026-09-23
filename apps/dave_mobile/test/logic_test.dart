import 'dart:convert';

import 'package:dave_mobile/api/client.dart';
import 'package:dave_mobile/api/models.dart';
import 'package:dave_mobile/push/push_service.dart';
import 'package:dave_mobile/theme.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('normaliseEndpoint', () {
    test('a bare host becomes https with no path', () {
      expect(normaliseEndpoint('dave-bot-production.up.railway.app').toString(), 'https://dave-bot-production.up.railway.app');
    });
    test('a pasted URL with a path and trailing slash means the same server', () {
      expect(normaliseEndpoint('  https://dave.up.railway.app/admin/?x=1 ').toString(), 'https://dave.up.railway.app');
    });
    test('plain http to the internet is refused -- the token would travel unencrypted', () {
      expect(normaliseEndpoint('http://dave.up.railway.app'), isNull);
    });
    test('plain http is allowed on the LAN and the emulator host', () {
      expect(normaliseEndpoint('http://192.168.1.20:3001').toString(), 'http://192.168.1.20:3001');
      expect(normaliseEndpoint('http://10.0.2.2:3001').toString(), 'http://10.0.2.2:3001');
      expect(normaliseEndpoint('http://localhost:3001').toString(), 'http://localhost:3001');
      expect(normaliseEndpoint('http://172.32.0.1'), isNull); // just outside 172.16/12
    });
    test('garbage is not an address', () {
      expect(normaliseEndpoint(''), isNull);
      expect(normaliseEndpoint('ftp://dave.app'), isNull);
      expect(normaliseEndpoint('https://'), isNull);
    });
  });

  group('formatting', () {
    test('money groups thousands and signs only when asked', () {
      expect(formatMoney(12345.678), '\$12,345.68');
      expect(formatMoney(-18.4), '-\$18.40');
      expect(formatMoney(18.4, signed: true), '+\$18.40');
      expect(formatMoney(0, signed: true), '\$0.00');
    });
    test('prices keep exactly their own precision', () {
      expect(formatPrice(196740), '196,740');
      expect(formatPrice(1.095), '1.095');
      expect(formatPrice(1.09512), '1.09512');
      expect(formatPrice(-2.5), '-2.5');
    });
    test('ago', () {
      final now = DateTime(2026, 9, 23, 12);
      expect(formatAgo(now.subtract(const Duration(seconds: 10)), now: now), 'just now');
      expect(formatAgo(now.subtract(const Duration(minutes: 4)), now: now), '4 min ago');
      expect(formatAgo(now.subtract(const Duration(hours: 2)), now: now), '2 h ago');
      expect(formatAgo(DateTime(2026, 9, 1), now: now), '2026-09-01');
    });
  });

  group('models parse what the server really sends', () {
    test('an empty dashboard (no EA yet) is nulls and an honest reason, not zeros', () {
      final d = Dashboard.fromJson({
        'account': {'balance': null, 'equity': null, 'freeMargin': null, 'leverage': null, 'updatedAt': null},
        'ea': {'connected': false, 'lastSeenAt': null},
        'open': {'positions': [], 'pendingOrders': [], 'count': 0, 'maxOpenTrades': null},
        'results': {'closedTrades': 0, 'wins': 0, 'losses': 0, 'winRatePercent': null, 'realisedPnl': 0},
        'heatmap': {'days': 365, 'buckets': []},
        'emptyReason': 'No EA report received yet',
      });
      expect(d.balance, isNull);
      expect(d.eaConnected, isFalse);
      expect(d.winRatePercent, isNull);
      expect(d.emptyReason, isNotNull);
      expect(d.openPnl, 0);
    });
    test('positions, orders and heatmap buckets', () {
      final d = Dashboard.fromJson({
        'account': {'balance': 1000.5, 'leverage': 500, 'updatedAt': 1758600000000},
        'ea': {'connected': true},
        'open': {
          'positions': [
            {'ticket': '11', 'symbol': 'VOL_75', 'type': 'buy', 'lots': 0.5, 'openPrice': 196740, 'pnl': 12.5},
            {'ticket': '12', 'symbol': 'EURUSD', 'type': 'sell', 'lots': 1, 'openPrice': 1.095, 'pnl': -2.5},
          ],
          'pendingOrders': [
            {'ticket': '13', 'symbol': 'EURUSD', 'type': 'buy_limit', 'lots': 1, 'price': 1.09},
          ],
          'maxOpenTrades': 3,
        },
        'results': {'closedTrades': 4, 'wins': 3, 'losses': 1, 'winRatePercent': 75, 'realisedPnl': 40.25},
        'heatmap': {
          'buckets': [
            {'day': '2026-09-22', 'pnl': 18.4, 'trades': 2},
          ],
        },
        'emptyReason': null,
      });
      expect(d.positions.first.isBuy, isTrue);
      expect(d.positions.last.isBuy, isFalse);
      expect(d.openPnl, 10);
      expect(d.pendingOrders.single.label, 'Buy limit');
      expect(d.heatmap.single.trades, 2);
      expect(d.leverage, 500);
      expect(d.emptyReason, isNull);
    });
    test('malformed fields degrade instead of crashing', () {
      final d = Dashboard.fromJson({'open': 'nonsense', 'results': 7});
      expect(d.positions, isEmpty);
      expect(d.closedTrades, 0);
      final b = BotState.fromJson({});
      expect(b.executionEnabled, isTrue); // absent means the default, which is on
      expect(b.intervalMinutes, 5);
    });
  });

  group('trade notifications', () {
    test('an open reads like a sentence', () {
      final d = describeTradeEvent(TradeEvent.fromJson(
          {'id': 1, 'type': 'opened', 'ticket': '9', 'symbol': 'VOL_75', 'side': 'sell', 'lots': 0.5, 'openPrice': 196740, 'sl': 197000, 'tp': 196000}));
      expect(d.title, 'VOL_75 sell opened');
      expect(d.body, '0.5 lots at 196,740  ·  SL 197,000  ·  TP 196,000');
    });
    test('a close carries the result and why', () {
      final d = describeTradeEvent(TradeEvent.fromJson({'id': 2, 'type': 'closed', 'ticket': '9', 'symbol': 'VOL_75', 'pnl': 18.4, 'reason': 'tp'}));
      expect(d.title, 'VOL_75 closed +\$18.40');
      expect(d.body, 'Take profit hit');
    });
    test('an open with nothing known still says something', () {
      final d = describeTradeEvent(TradeEvent.fromJson({'id': 3, 'type': 'opened', 'symbol': 'XAUUSD'}));
      expect(d.title, 'XAUUSD opened');
      expect(d.body, 'New position');
    });
    test('a long gap is summarised as one notification', () {
      final events = [
        TradeEvent.fromJson({'id': 1, 'type': 'opened', 'symbol': 'A'}),
        TradeEvent.fromJson({'id': 2, 'type': 'closed', 'symbol': 'A', 'pnl': 10}),
        TradeEvent.fromJson({'id': 3, 'type': 'closed', 'symbol': 'B', 'pnl': -4}),
        TradeEvent.fromJson({'id': 4, 'type': 'opened', 'symbol': 'C'}),
      ];
      final s = describeCatchUp(events);
      expect(s.title, '4 trades while you were away');
      expect(s.body, '2 opened, 2 closed  ·  +\$6.00 realised');
    });
  });

  group('SSE parser', () {
    List<SseFrame> feed(String raw) {
      final p = SseParser();
      return [for (final line in const LineSplitter().convert(raw)) ?p.addLine(line)];
    }

    test('frames, ids, heartbeats and multi-line data', () {
      final frames = feed(': heartbeat\n\n'
          'event: ready\ndata: {"latestId":4}\n\n'
          'id: 5\nevent: trade\ndata: {"a":1,\ndata: "b":2}\n\n'
          ': heartbeat\n\n');
      expect(frames.length, 2);
      expect(frames[0].event, 'ready');
      expect(frames[1].event, 'trade');
      expect(frames[1].id, '5');
      expect(jsonDecode(frames[1].data), {'a': 1, 'b': 2});
    });
    test('an event name does not leak into the next frame', () {
      final frames = feed('event: trade\ndata: 1\n\ndata: 2\n\n');
      expect(frames[1].event, 'message');
    });
  });

  group('API client', () {
    test('401 means unpaired -- the one error retrying cannot fix', () async {
      final api = DaveApi(base: Uri.parse('https://x.test'), token: 't', client: MockClient((_) async => http.Response('{"error":"unpaired"}', 401)));
      await expectLater(api.dashboard(), throwsA(isA<UnpairedException>()));
    });
    test('the token goes in the Authorization header and nowhere else', () async {
      late http.Request seen;
      final api = DaveApi(
          base: Uri.parse('https://x.test'),
          token: 'secret',
          client: MockClient((r) async {
            seen = r;
            return http.Response('{"running":true,"executionEnabled":false,"intervalMinutes":3}', 200);
          }));
      final bot = await api.bot();
      expect(seen.headers['authorization'], 'Bearer secret');
      expect(seen.url.toString(), 'https://x.test/api/app/bot');
      expect(bot.executionEnabled, isFalse);
    });
    test('updateBot sends only the fields that changed', () async {
      final bodies = <String>[];
      final api = DaveApi(
          base: Uri.parse('https://x.test'),
          token: 't',
          client: MockClient((r) async {
            if (r.method == 'POST') bodies.add(r.body);
            return http.Response('{"running":false}', 200);
          }));
      await api.updateBot(running: false);
      expect(jsonDecode(bodies.single), {'running': false});
    });
    test('server errors surface their own message', () async {
      final api = DaveApi(base: Uri.parse('https://x.test'), token: 't', client: MockClient((_) async => http.Response('{"error":"Interval must be 1-60"}', 400)));
      await expectLater(api.updateBot(intervalMinutes: 99), throwsA(predicate((e) => e is ApiException && e.message == 'Interval must be 1-60')));
    });
    test('pairing upper-cases the code and returns the token', () async {
      final result = await DaveApi.pair(Uri.parse('https://x.test'), ' abc234 ', 'Android phone', client: MockClient((r) async {
        expect(jsonDecode(r.body)['code'], 'ABC234');
        return http.Response('{"token":"tok","device":{"id":"d1"}}', 200);
      }));
      expect(result.token, 'tok');
      expect(result.deviceId, 'd1');
    });
  });
}
