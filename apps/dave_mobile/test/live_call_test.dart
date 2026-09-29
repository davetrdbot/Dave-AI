import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dave_mobile/api/gemini_live.dart';
import 'package:dave_mobile/screens/voice.dart';
import 'package:flutter_test/flutter_test.dart';

/// Google's side of the socket, faked: records what the phone sends, lets the test speak for Gemini.
class FakeSocket implements LiveSocket {
  final sent = <Map<String, dynamic>>[];
  final _in = StreamController<Object>();
  bool closed = false;
  @override
  Stream<Object> get messages => _in.stream;
  @override
  void send(String text) => sent.add((jsonDecode(text) as Map).cast<String, dynamic>());
  @override
  void close() {
    closed = true;
    _in.close();
  }

  void server(Map<String, dynamic> m) => _in.add(utf8.encode(jsonEncode(m))); // Google sends binary frames
}

class FakeAudio implements LiveAudio {
  void Function(Uint8List)? mic;
  final played = <int>[];
  int flushes = 0;
  bool stopped = false;
  @override
  Future<void> startMic(void Function(Uint8List pcm) onChunk) async => mic = onChunk;
  @override
  Future<void> startSpeaker({required void Function() onDrained, required void Function(double level) onLevel}) async {}
  @override
  void play(Uint8List pcm) => played.addAll(pcm);
  @override
  void flush() => flushes++;
  @override
  bool get playing => false;
  @override
  Future<void> stop() async => stopped = true;
}

void main() {
  test('a live call: setup, voice both ways, tools through the bot, the yes gate, the transcript', () async {
    final sockets = <FakeSocket>[];
    final audio = FakeAudio();
    final toolCalls = <String>[];
    List<Map<String, String>>? savedTranscript;
    var starts = 0;
    final call = LiveCall(
      start: () async {
        starts++;
        return {
          'url': 'wss://example/live?access_token=t$starts',
          'model': 'gemini-3.8-live',
          'setup': {
            'setup': {'model': 'models/gemini-3.8-live'},
          },
        };
      },
      runTool: (name, args) async {
        toolCalls.add('$name ${jsonEncode(args)}');
        if (name == 'set_breakeven' && args['confirmed'] != true) return {'needsConfirmation': true, 'instruction': 'ask'};
        return {'result': 'ok'};
      },
      onEnd: (t, s) async => savedTranscript = t,
      audio: audio,
      connect: (url) async {
        final s = FakeSocket();
        sockets.add(s);
        return s;
      },
    );
    await call.begin();
    final ws = sockets.single;
    expect(ws.sent.first, {
      'setup': {'model': 'models/gemini-3.8-live'},
    }, reason: 'the bot-made setup goes first');
    expect(call.phase, VoicePhase.connecting);

    // Mic audio waits for setupComplete, then streams as 16 kHz PCM.
    audio.mic!(Uint8List(640));
    expect(ws.sent.length, 1);
    ws.server({'setupComplete': {}});
    await pumpEventQueue();
    expect(call.phase, VoicePhase.listening);
    audio.mic!(Uint8List.fromList(List.filled(640, 9)));
    final chunk = ws.sent.last['realtimeInput']['audio'];
    expect(chunk['mimeType'], 'audio/pcm;rate=16000');
    expect(base64Decode(chunk['data'] as String).length, 640);

    // The trader speaks; Dave answers out loud.
    ws.server({
      'serverContent': {
        'inputTranscription': {'text': 'Move gold '},
      },
    });
    ws.server({
      'serverContent': {
        'inputTranscription': {'text': 'to breakeven'},
      },
    });
    ws.server({
      'serverContent': {
        'modelTurn': {
          'parts': [
            {
              'inlineData': {'mimeType': 'audio/pcm;rate=24000', 'data': base64Encode([1, 2, 3, 4])},
            },
          ],
        },
        'outputTranscription': {'text': 'Checking it now.'},
      },
    });
    await pumpEventQueue();
    expect(audio.played, [1, 2, 3, 4]);
    expect(call.phase, VoicePhase.speaking);
    expect(call.lines.map((l) => '${l.me ? 'me' : 'dave'}:${l.text}').toList(), ['me:Move gold to breakeven', 'dave:Checking it now.']);

    // The trader cuts in: what Dave hadn't said yet is dropped.
    ws.server({
      'serverContent': {'interrupted': true},
    });
    await pumpEventQueue();
    expect(audio.flushes, 1);
    expect(call.phase, VoicePhase.listening);

    // A trade action: the bot refuses without a yes, the confirm card shows.
    ws.server({
      'toolCall': {
        'functionCalls': [
          {
            'id': 'c1',
            'name': 'set_breakeven',
            'args': {'ticket': 501},
          },
        ],
      },
    });
    await pumpEventQueue();
    expect(toolCalls, ['set_breakeven {"ticket":501}']);
    final response = ws.sent.last['toolResponse']['functionResponses'][0];
    expect(response['id'], 'c1');
    expect(response['response']['needsConfirmation'], true);
    expect(call.phase, VoicePhase.confirm);
    expect(call.confirm!.title, 'Breakeven #501');

    // Tapping Yes tells Gemini it's a yes.
    call.answerConfirm(true);
    expect(call.confirm, isNull);
    expect(ws.sent.last['realtimeInput']['text'], contains('I tapped YES'));
    expect(call.lines.last.text, 'Yes, do it.');

    // Typed instead of spoken.
    call.sendText('and set a reminder at 2650');
    expect(ws.sent.last, {
      'realtimeInput': {'text': 'and set a reminder at 2650'},
    });

    // Mute: no audio goes out, and Gemini is told the stream paused.
    call.toggleMute();
    expect(ws.sent.last['realtimeInput']['audioStreamEnd'], true);
    final before = ws.sent.length;
    audio.mic!(Uint8List(640));
    expect(ws.sent.length, before);
    call.toggleMute();

    // Google resets the socket: the call picks up with a fresh token and the resumption handle.
    ws.server({
      'sessionResumptionUpdate': {'newHandle': 'h-1', 'resumable': true},
    });
    ws.server({
      'goAway': {'timeLeft': '5s'},
    });
    await pumpEventQueue();
    expect(call.error, isNull);
    expect(sockets.length, 2);
    expect(starts, 2);
    expect(sockets[1].sent.first['setup']['sessionResumption'], {'handle': 'h-1'});
    expect(call.ended, isFalse);

    // Hang up: everything stops, the transcript goes to the chat.
    await call.hangUp();
    expect(audio.stopped, isTrue);
    expect(sockets[1].closed, isTrue);
    expect(savedTranscript, [
      {'who': 'me', 'text': 'Move gold to breakeven'},
      {'who': 'dave', 'text': 'Checking it now.'},
      {'who': 'me', 'text': 'Yes, do it.'},
      {'who': 'me', 'text': 'and set a reminder at 2650'},
    ]);
  });

  test('a call that cannot start says why and ends', () async {
    final call = LiveCall(
      start: () async => throw const LiveError('Add your Gemini API key first.'),
      runTool: (_, _) async => {},
      audio: FakeAudio(),
    );
    await call.begin();
    expect(call.ended, isTrue);
    expect(call.error, 'Add your Gemini API key first.');
  });

  test('tool rail labels', () {
    expect(toolLook('get_price', {'symbol': 'XAUUSD'}).label, 'Price XAUUSD');
    expect(toolLook('get_trend', {'symbol': 'EURUSD', 'timeframe': 'H4'}).label, 'Trend EURUSD H4');
    expect(toolLook('get_order_blocks', {}).label, 'Order blocks');
    expect(toolLook('ask_dave', {}).label, 'Asking full Dave');
    expect(toolLook('something_new', {}).label, 'Something new');
  });
}
