import 'dart:convert';

import 'package:dave_mobile/api/chat.dart';
import 'package:dave_mobile/screens/incoming_call.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Dave calling: the ringing screen shows who and why, and Decline tells the bot.
void main() {
  testWidgets('incoming call shows the reason; Decline reports it', (tester) async {
    final posted = <Map<String, dynamic>>[];
    final api = ChatApi(
      base: Uri.parse('https://bot.example'),
      token: 't',
      client: MockClient((req) async {
        posted.add({'path': req.url.path, ...jsonDecode(req.body) as Map<String, dynamic>});
        return http.Response('{"ok":true}', 200, headers: {'content-type': 'application/json'});
      }),
    );
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(CupertinoApp(navigatorKey: nav, home: const CupertinoPageScaffold(child: Text('home'))));
    IncomingCallPage.show(nav.currentState!, api: api, callId: 'call-1', reason: 'Gold swept the Asian low -- take the long?', symbol: 'XAUUSD');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    final err = tester.takeException();
    expect(err, isNull, reason: '$err');
    expect(find.text('Dave'), findsOneWidget);
    expect(find.text('is calling about XAUUSD…'), findsOneWidget);
    expect(find.textContaining('Asian low'), findsOneWidget);
    expect(find.byKey(const ValueKey('call-answer')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('call-decline')));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('home'), findsOneWidget, reason: 'the ringing screen closes');
    expect(posted.single['path'], '/api/app/chat/call/status');
    expect(posted.single['callId'], 'call-1');
    expect(posted.single['status'], 'declined');

    // The same call never rings twice.
    IncomingCallPage.show(nav.currentState!, api: api, callId: 'call-1', reason: 'x');
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Dave'), findsNothing);
  });
}
