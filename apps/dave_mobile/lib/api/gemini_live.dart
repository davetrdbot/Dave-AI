import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/cupertino.dart';
import 'package:flutter_pcm_sound/flutter_pcm_sound.dart' as pcm;
import 'package:record/record.dart';

import '../screens/voice.dart';

/// A live voice call with Dave over Gemini Live.
///
/// The phone talks to Google directly (the lowest delay for audio), with a one-use token the bot
/// mints from the trader's key -- the key itself never reaches the phone. The bot also hands over
/// the whole session setup (Dave's call instructions and his tools). When Gemini wants a tool, the
/// call sends it to the bot ([runTool]) and passes the answer back. Trade actions are refused by the
/// bot until they come with the trader's yes.
///
///   mic (16 kHz PCM) -> realtimeInput -> Gemini -> audio (24 kHz PCM) -> speaker
///                                          \-> toolCall -> bot -> toolResponse
class LiveCall extends ChangeNotifier {
  LiveCall({
    required this.start,
    required this.runTool,
    this.onEnd,
    LiveAudio? audio,
    this.connect = _connectSocket,
  }) : audio = audio ?? PhoneAudio();

  /// POST live/start: the socket url, token and the setup message.
  final Future<Map<String, dynamic>> Function() start;

  /// POST live/tool.
  final Future<Map<String, dynamic>> Function(
    String name,
    Map<String, dynamic> args,
  )
  runTool;

  /// POST live/end, with the transcript.
  final Future<void> Function(
    List<Map<String, String>> transcript,
    int seconds,
  )?
  onEnd;
  final LiveAudio audio;
  final Future<LiveSocket> Function(String url) connect;

  /// Runs once, the first time the session is ready (a call Dave placed: he speaks first).
  VoidCallback? onReady;
  bool _readyOnce = false;

  VoicePhase phase = VoicePhase.connecting;
  String model = 'Gemini Live';
  bool thinking = false;
  final List<VoiceLine> lines = [];
  final List<VoiceTool> tools = [];
  final List<String> thoughts = [];
  VoiceConfirm? confirm;
  bool muted = false;
  double level = 0;
  Duration elapsed = Duration.zero;
  String? error;
  bool ended = false;

  LiveSocket? _ws;
  bool _ready = false;
  String? _resumeHandle;
  int _reconnects = 0;
  Timer? _clock;
  final _started = DateTime.now();
  bool _turnDone = true;
  final Map<String, int> _toolIndex = {};
  final Map<String, DateTime> _toolStart = {};

  Future<void> begin() async {
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      elapsed = DateTime.now().difference(_started);
      _notify();
    });
    try {
      await _open();
      await audio.startSpeaker(
        onDrained: _speakerDrained,
        onLevel: (l) {
          if (phase == VoicePhase.speaking) {
            level = l;
            _notify();
          }
        },
      );
      await audio.startMic(_micChunk);
    } catch (e) {
      _fail(e is LiveError ? e.message : _friendly(e));
    }
  }

  Future<void> _open() async {
    final s = await start();
    model = s['model'] == null ? model : _modelName(s['model'] as String);
    thinking = (s['model'] as String? ?? '').contains('thinking');
    final setup = (jsonDecode(jsonEncode(s['setup'])) as Map).cast<String, dynamic>();
    if (_resumeHandle != null) {
      (setup['setup'] as Map)['sessionResumption'] = {'handle': _resumeHandle};
    }
    _ready = false;
    final ws = await connect(s['url'] as String);
    _ws = ws;
    ws.messages.listen(
      (m) => handle(m),
      onDone: () => _closed(ws),
      onError: (_) => _closed(ws),
      cancelOnError: true,
    );
    ws.send(jsonEncode(setup));
  }

  static String _modelName(String id) =>
      id.contains('thinking') ? 'Gemini Live · deep thinking' : 'Gemini Live';

  /// One message from Google (public for tests).
  void handle(Object raw) {
    final Map<String, dynamic> m;
    try {
      m = (jsonDecode(
        raw is String ? raw : utf8.decode(raw as List<int>),
      ) as Map).cast<String, dynamic>();
    } catch (_) {
      return;
    }
    if (m.containsKey('setupComplete')) {
      _ready = true;
      _reconnects = 0;
      if (phase == VoicePhase.connecting) phase = VoicePhase.listening;
      if (!_readyOnce) {
        _readyOnce = true;
        onReady?.call();
      }
    }
    final sc = m['serverContent'] as Map?;
    if (sc != null) _content(sc.cast<String, dynamic>());
    final tc = m['toolCall'] as Map?;
    if (tc != null) {
      for (final c in (tc['functionCalls'] as List? ?? const [])) {
        unawaited(_tool((c as Map).cast<String, dynamic>()));
      }
    }
    final cancel = m['toolCallCancellation'] as Map?;
    if (cancel != null) {
      for (final id in (cancel['ids'] as List? ?? const [])) {
        final i = _toolIndex[id];
        if (i != null && tools[i].state == ToolRun.running) {
          tools[i] = VoiceTool(
            icon: tools[i].icon,
            label: tools[i].label,
            state: ToolRun.failed,
            result: 'cancelled',
          );
        }
      }
    }
    final resume = m['sessionResumptionUpdate'] as Map?;
    if (resume != null &&
        resume['resumable'] != false &&
        resume['newHandle'] is String) {
      _resumeHandle = resume['newHandle'] as String;
    }
    if (m.containsKey('goAway')) unawaited(_reconnect());
    _notify();
  }

  void _content(Map<String, dynamic> sc) {
    if (sc['interrupted'] == true) {
      // The trader cut in: drop what he hasn't said yet.
      audio.flush();
      _finishLine(me: false);
      phase = VoicePhase.listening;
    }
    final input = (sc['inputTranscription'] as Map?)?['text'];
    if (input is String && input.isNotEmpty) _append(me: true, text: input);
    final output = (sc['outputTranscription'] as Map?)?['text'];
    if (output is String && output.isNotEmpty) {
      _finishLine(me: true);
      _append(me: false, text: output);
    }
    final parts = ((sc['modelTurn'] as Map?)?['parts'] as List?) ?? const [];
    for (final p in parts.cast<Map>()) {
      final data = p['inlineData'] as Map?;
      if (data != null &&
          (data['mimeType'] as String? ?? '').startsWith('audio/pcm')) {
        _turnDone = false;
        _finishLine(me: true);
        audio.play(base64Decode(data['data'] as String));
        if (confirm == null) phase = VoicePhase.speaking;
      } else if (p['thought'] == true && p['text'] is String) {
        final t = (p['text'] as String).replaceAll(RegExp(r'\*\*'), '').trim();
        if (t.isNotEmpty) {
          thoughts.add(t.length > 160 ? '${t.substring(0, 157)}...' : t);
          if (thoughts.length > 3) thoughts.removeAt(0);
          if (phase != VoicePhase.speaking && confirm == null) {
            phase = VoicePhase.thinking;
          }
        }
      }
    }
    if (sc['turnComplete'] == true) {
      _turnDone = true;
      _finishLine(me: false);
      thoughts.clear();
      if (!audio.playing && confirm == null) phase = VoicePhase.listening;
    }
  }

  void _speakerDrained() {
    if (_turnDone && phase == VoicePhase.speaking) {
      phase = VoicePhase.listening;
      level = 0;
      _notify();
    }
  }

  Future<void> _tool(Map<String, dynamic> call) async {
    final id = call['id'] as String? ?? '';
    final name = call['name'] as String? ?? '';
    final args = (call['args'] as Map?)?.cast<String, dynamic>() ?? {};
    final look = toolLook(name, args);
    _toolIndex[id] = tools.length;
    _toolStart[id] = DateTime.now();
    tools.add(
      VoiceTool(icon: look.icon, label: look.label, state: ToolRun.running),
    );
    if (tools.length > 4) {
      tools.removeAt(0);
      _toolIndex.updateAll((_, v) => v - 1);
    }
    if (confirm == null) phase = VoicePhase.tools;
    _notify();
    Map<String, dynamic> result;
    try {
      result = await runTool(name, args);
    } catch (e) {
      result = {'error': _friendly(e)};
    }
    final i = _toolIndex[id];
    final ms = DateTime.now()
        .difference(_toolStart[id] ?? DateTime.now())
        .inMilliseconds;
    if (i != null && i < tools.length) {
      tools[i] = VoiceTool(
        icon: look.icon,
        label: look.label,
        state: result['error'] != null ? ToolRun.failed : ToolRun.done,
        result: result['needsConfirmation'] == true
            ? 'needs your yes'
            : (result['error'] != null ? 'failed' : null),
        ms: ms,
      );
    }
    if (result['needsConfirmation'] == true) {
      confirm = VoiceConfirm(
        title: look.label,
        detail: _argsLine(args),
        risk: 'Nothing changes until you say yes or tap it.',
      );
      phase = VoicePhase.confirm;
    } else if (phase == VoicePhase.tools &&
        !tools.any((t) => t.state == ToolRun.running)) {
      phase = VoicePhase.thinking;
    }
    _send({
      'toolResponse': {
        'functionResponses': [
          {'id': id, 'name': name, 'response': result},
        ],
      },
    });
    _notify();
  }

  /// The trader tapped Yes / No on the confirm card: Gemini hears it as their answer.
  void answerConfirm(bool yes) {
    final what = confirm?.title ?? 'that';
    confirm = null;
    phase = VoicePhase.thinking;
    sendText(
      yes
          ? '(I tapped YES on the screen: go ahead with "$what" now -- call it with confirmed: true.)'
          : '(I tapped NO on the screen: do not do "$what".)',
      show: false,
    );
    lines.add(VoiceLine(me: true, text: yes ? 'Yes, do it.' : 'No.'));
    _notify();
  }

  /// Typed instead of spoken.
  void sendText(String text, {bool show = true}) {
    if (text.trim().isEmpty) return;
    if (show) {
      _finishLine(me: false);
      lines.add(VoiceLine(me: true, text: text.trim()));
    }
    _send({
      'realtimeInput': {'text': text.trim()},
    });
    _notify();
  }

  void toggleMute() {
    muted = !muted;
    if (muted) {
      _send({
        'realtimeInput': {'audioStreamEnd': true},
      });
      level = 0;
    }
    _notify();
  }

  void _micChunk(Uint8List pcm) {
    if (muted || !_ready || ended) return;
    _send({
      'realtimeInput': {
        'audio': {
          'data': base64Encode(pcm),
          'mimeType': 'audio/pcm;rate=16000',
        },
      },
    });
    if (phase == VoicePhase.listening) {
      level = pcmLevel(pcm);
      _notify();
    }
  }

  void _send(Map<String, dynamic> msg) {
    if (_ws == null || ended) return;
    try {
      _ws!.send(jsonEncode(msg));
    } catch (_) {
      /* the socket is closing; _closed reconnects */
    }
  }

  void _append({required bool me, required String text}) {
    if (lines.isNotEmpty && lines.last.me == me && lines.last.partial) {
      lines[lines.length - 1] = VoiceLine(
        me: me,
        text: '${lines.last.text}$text',
        partial: true,
      );
    } else {
      lines.add(VoiceLine(me: me, text: text.trimLeft(), partial: true));
    }
    if (lines.length > 200) lines.removeAt(0);
  }

  void _finishLine({required bool me}) {
    for (var i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
      if (lines[i].me == me && lines[i].partial) {
        lines[i] = VoiceLine(me: me, text: lines[i].text.trim());
      }
    }
  }

  void _closed(LiveSocket ws) {
    if (ended || ws != _ws) return;
    unawaited(_reconnect());
  }

  /// Google closes a live socket every ~10 minutes (it warns with goAway first): pick the same
  /// conversation back up with a fresh token and the last resumption handle.
  Future<void> _reconnect() async {
    if (ended) return;
    final old = _ws;
    _ws = null;
    _ready = false;
    old?.close();
    if (_resumeHandle == null || _reconnects >= 3) {
      _fail(
        _reconnects >= 3
            ? 'The line to Dave keeps dropping -- check your connection and call again.'
            : 'The call dropped -- call again.',
      );
      return;
    }
    _reconnects++;
    try {
      await _open();
    } catch (e) {
      _fail(e is LiveError ? e.message : _friendly(e));
    }
  }

  void _fail(String message) {
    error = message;
    unawaited(hangUp());
  }

  /// End the call; the transcript goes into the chat history.
  Future<void> hangUp() async {
    if (ended) return;
    ended = true;
    _clock?.cancel();
    _ws?.close();
    _ws = null;
    await audio.stop();
    final transcript = [
      for (final l in lines)
        if (l.text.trim().isNotEmpty)
          {'who': l.me ? 'me' : 'dave', 'text': l.text.trim()},
    ];
    _notify();
    try {
      await onEnd?.call(transcript, elapsed.inSeconds);
    } catch (_) {
      /* the call is over either way */
    }
  }

  bool _disposed = false;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(hangUp());
    super.dispose();
  }

  VoiceSession get session => VoiceSession(
    phase: phase,
    model: model,
    voice: voiceName,
    thinkingLevel: thinking ? 'on' : null,
    elapsed: elapsed,
    limit: const Duration(minutes: 30),
    level: level,
    tools: List.of(tools),
    lines: List.of(lines),
    thoughts: List.of(thoughts),
    confirm: confirm,
    muted: muted,
  );
  String voiceName = 'Charon';
}

String _friendly(Object e) {
  final s = e.toString().replaceFirst(
    RegExp(r'^(Exception|ApiException|SocketException|WebSocketException): ?'),
    '',
  );
  if (e is SocketException || e is WebSocketException) {
    return "Couldn't reach Google's voice service -- check your connection.";
  }
  return s.length > 200 ? '${s.substring(0, 200)}...' : s;
}

class LiveError implements Exception {
  const LiveError(this.message);
  final String message;
  @override
  String toString() => message;
}

String _argsLine(Map<String, dynamic> args) {
  final parts = <String>[];
  args.forEach((k, v) {
    if (k == 'confirmed' || v == null) return;
    parts.add('${k.replaceAll('_', ' ')}: $v');
  });
  return parts.isEmpty ? 'As Dave described it.' : parts.join(' · ');
}

/// 0..1 loudness of a PCM16 chunk (for the orb).
double pcmLevel(Uint8List pcm) {
  if (pcm.length < 2) return 0;
  final data = ByteData.sublistView(pcm);
  var sum = 0.0;
  final n = pcm.length ~/ 2;
  for (var i = 0; i < n; i += 4) {
    final s = data.getInt16(i * 2, Endian.little) / 32768;
    sum += s * s;
  }
  final rms = math.sqrt(sum / (n / 4).ceil());
  return (rms * 4).clamp(0.0, 1.0);
}

/// How a tool looks on the call's tool rail.
({IconData icon, String label}) toolLook(
  String name,
  Map<String, dynamic> args,
) {
  final sym = (args['symbol'] ?? args['pair'] ?? '').toString();
  final tf = (args['timeframe'] ?? '').toString();
  final on = [sym, tf].where((s) => s.isNotEmpty).join(' ');
  final ticket = args['ticket'] != null ? '#${args['ticket']}' : '';
  String l(String base, [String extra = '']) =>
      [base, extra].where((s) => s.isNotEmpty).join(' ');
  return switch (name) {
    'get_live_state' => (
      icon: CupertinoIcons.chart_bar_alt_fill,
      label: 'Open trades',
    ),
    'get_account_balance' => (
      icon: CupertinoIcons.money_dollar_circle,
      label: 'Balance',
    ),
    'get_price' => (icon: CupertinoIcons.tag, label: l('Price', on)),
    'get_candles' => (
      icon: CupertinoIcons.graph_square,
      label: l('Candles', on),
    ),
    'get_trend' || 'get_structure' || 'get_momentum' => (
      icon: CupertinoIcons.arrow_up_right,
      label: l(name.substring(4)[0].toUpperCase() + name.substring(5), on),
    ),
    'get_volatility' => (
      icon: CupertinoIcons.waveform_path,
      label: l('Volatility', on),
    ),
    'get_zones' || 'get_levels' || 'get_order_blocks' || 'get_liquidity' => (
      icon: CupertinoIcons.square_stack_3d_up,
      label: l(
        name
            .substring(4)
            .replaceAll('_', ' ')
            .replaceFirstMapped(RegExp('^.'), (m) => m[0]!.toUpperCase()),
        on,
      ),
    ),
    'get_news' => (icon: CupertinoIcons.news, label: 'News'),
    'web_search' => (icon: CupertinoIcons.globe, label: 'Searching the web'),
    'recall_memory' => (icon: CupertinoIcons.lightbulb, label: 'Memory'),
    'ask_dave' => (icon: CupertinoIcons.sparkles, label: 'Asking full Dave'),
    'set_breakeven' => (
      icon: CupertinoIcons.shield_lefthalf_fill,
      label: l('Breakeven', ticket),
    ),
    'modify_sl_tp' => (
      icon: CupertinoIcons.slider_horizontal_3,
      label: l('Move SL/TP', ticket),
    ),
    'partial_close' => (
      icon: CupertinoIcons.scissors,
      label: l('Close part', ticket),
    ),
    'full_close' => (
      icon: CupertinoIcons.xmark_circle,
      label: l('Close trade', ticket),
    ),
    'trade_execute' => (
      icon: CupertinoIcons.bolt_fill,
      label: l('New trade', on),
    ),
    'set_reminder' => (icon: CupertinoIcons.alarm, label: 'Reminder'),
    _ => (
      icon: CupertinoIcons.wrench,
      label: name
          .replaceAll('_', ' ')
          .replaceFirstMapped(RegExp('^.'), (m) => m[0]!.toUpperCase()),
    ),
  };
}

// ───────────────────────────── plumbing (swappable in tests) ─────────────────────────────

abstract class LiveSocket {
  Stream<Object> get messages;
  void send(String text);
  void close();
}

class _IoSocket implements LiveSocket {
  _IoSocket(this._ws);
  final WebSocket _ws;
  @override
  Stream<Object> get messages => _ws.cast<Object>();
  @override
  void send(String text) => _ws.add(text);
  @override
  void close() => unawaited(_ws.close());
}

Future<LiveSocket> _connectSocket(String url) async => _IoSocket(
  await WebSocket.connect(url).timeout(const Duration(seconds: 15)),
);

abstract class LiveAudio {
  Future<void> startMic(void Function(Uint8List pcm) onChunk);
  Future<void> startSpeaker({
    required void Function() onDrained,
    required void Function(double level) onLevel,
  });
  void play(Uint8List pcm);
  void flush();
  bool get playing;
  Future<void> stop();
}

/// The phone's mic (16 kHz PCM, echo cancelled -- Dave mustn't hear himself on the speaker) and
/// speaker (Gemini's 24 kHz PCM, fed as it arrives).
/// How loud the trader must speak (0..1, see pcmLevel) to cut in while Dave is talking.
const double bargeInLevel = 0.45;

class PhoneAudio implements LiveAudio {
  AudioRecorder? _rec;
  StreamSubscription<Uint8List>? _mic;
  final List<Uint8List> _queue = [];
  bool _speaker = false;
  bool _playing = false;
  void Function()? _drained;
  void Function(double)? _level;

  @override
  bool get playing => _playing || _queue.isNotEmpty;

  @override
  Future<void> startMic(void Function(Uint8List pcm) onChunk) async {
    final rec = _rec ??= AudioRecorder();
    if (!await rec.hasPermission()) {
      throw const LiveError(
        'Dave needs the microphone to hear you -- allow it in your phone settings.',
      );
    }
    final stream = await rec.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: 16000,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
        autoGain: true,
        // Media, not a phone call (the trader: "use media speaker not call speaker"): in
        // communication mode Android routes the whole app into the call path -- call volume,
        // call speaker. Normal mode keeps Dave on the media speaker and media volume.
        androidConfig: AndroidRecordConfig(
          audioSource: AndroidAudioSource.voiceRecognition,
          audioManagerMode: AudioManagerMode.modeNormal,
        ),
      ),
    );
    // Media playback isn't echo-cancelled like a call, so while Dave is talking only clearly
    // louder speech (the trader cutting in) gets through -- otherwise he'd hear himself.
    _mic = stream.listen((chunk) {
      if (playing && pcmLevel(chunk) < bargeInLevel) return;
      onChunk(chunk);
    });
  }

  @override
  Future<void> startSpeaker({
    required void Function() onDrained,
    required void Function(double level) onLevel,
  }) async {
    _drained = onDrained;
    _level = onLevel;
    await pcm.FlutterPcmSound.setLogLevel(pcm.LogLevel.none);
    await pcm.FlutterPcmSound.setup(
      sampleRate: 24000,
      channelCount: 1,
      iosAudioCategory: pcm.IosAudioCategory.playAndRecord,
    );
    // Small buffer: when the trader cuts in, only ~0.2 s of Dave is left to play out.
    await pcm.FlutterPcmSound.setFeedThreshold(4800);
    pcm.FlutterPcmSound.setFeedCallback(_feed);
    _speaker = true;
  }

  void _feed(int remaining) {
    if (_queue.isEmpty) {
      if (remaining == 0) {
        _playing = false;
        _drained?.call();
      }
      return;
    }
    // ~0.2 s at a time.
    final out = BytesBuilder(copy: false);
    while (_queue.isNotEmpty && out.length < 9600) {
      out.add(_queue.removeAt(0));
    }
    final bytes = Uint8List.fromList(
      out.takeBytes(),
    ); // its own buffer: feed() sends the whole buffer
    _level?.call(pcmLevel(bytes));
    _playing = true;
    unawaited(
      pcm.FlutterPcmSound.feed(
        pcm.PcmArrayInt16(bytes: ByteData.sublistView(bytes)),
      ),
    );
  }

  @override
  void play(Uint8List chunk) {
    if (!_speaker) return;
    _queue.add(chunk);
    if (!_playing) pcm.FlutterPcmSound.start();
  }

  @override
  void flush() => _queue.clear();

  @override
  Future<void> stop() async {
    await _mic?.cancel();
    _mic = null;
    try {
      await _rec?.stop();
      await _rec?.dispose();
    } catch (_) {}
    _rec = null;
    _queue.clear();
    if (_speaker) {
      _speaker = false;
      pcm.FlutterPcmSound.setFeedCallback(null);
      try {
        await pcm.FlutterPcmSound.release();
      } catch (_) {}
    }
  }
}
