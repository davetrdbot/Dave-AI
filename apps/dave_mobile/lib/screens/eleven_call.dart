import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:record/record.dart';

import '../api/chat.dart';
import '../look.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'dave_voice.dart';

/// Calling Dave in his ElevenLabs voice (the trader: "call dave via elevenlabs -- the LLM talks,
/// ElevenLabs speaks"). Hands-free: it listens, notices when you stop talking, sends what you said
/// to the bot (Groq Whisper -> Dave's full brain with every tool -> his ElevenLabs voice), plays the
/// answer on the MEDIA speaker, then listens again.
class ElevenCallPage extends StatefulWidget {
  const ElevenCallPage({super.key, required this.api});
  final ChatApi api;

  static Future<void> open(BuildContext context, ChatApi api) async {
    await Navigator.of(context, rootNavigator: true).push(
      CupertinoPageRoute<void>(fullscreenDialog: true, builder: (_) => ElevenCallPage(api: api)),
    );
  }

  @override
  State<ElevenCallPage> createState() => _ElevenCallPageState();
}

enum _Phase { listening, thinking, speaking, muted }

/// Louder than this (dBFS) is speech; quieter is the room.
const double _speechDb = -38;
/// This long quiet after speech ends your turn.
const Duration _endOfTurn = Duration(milliseconds: 1300);
/// A turn is never longer than this.
const Duration _maxTurn = Duration(seconds: 45);

class _ElevenCallPageState extends State<ElevenCallPage> {
  final AudioRecorder _rec = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();
  StreamSubscription<Amplitude>? _amp;
  StreamSubscription<void>? _done;
  Timer? _maxTimer;
  _Phase _phase = _Phase.listening;
  bool _heardSpeech = false;
  DateTime? _quietSince;
  String? _path;
  double _level = 0;
  final List<(bool dave, String text)> _lines = [];
  final Stopwatch _clock = Stopwatch()..start();
  Timer? _tick;
  bool _ended = false;

  @override
  void initState() {
    super.initState();
    unawaited(DaveAudio.stop());
    // Dave plays like music or a video: media volume, the loud speaker -- never the call earpiece.
    unawaited(_player.setAudioContext(AudioContext(
      android: const AudioContextAndroid(
        isSpeakerphoneOn: false,
        audioMode: AndroidAudioMode.normal,
        stayAwake: true,
        contentType: AndroidContentType.speech,
        usageType: AndroidUsageType.media,
        audioFocus: AndroidAudioFocus.gain,
      ),
      iOS: AudioContextIOS(category: AVAudioSessionCategory.playAndRecord, options: const {AVAudioSessionOptions.defaultToSpeaker}),
    )));
    _done = _player.onPlayerComplete.listen((_) => _listen());
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
    unawaited(_listen());
  }

  @override
  void dispose() {
    _ended = true;
    _tick?.cancel();
    _maxTimer?.cancel();
    unawaited(_amp?.cancel());
    unawaited(_done?.cancel());
    unawaited(_rec.dispose());
    unawaited(_player.dispose());
    super.dispose();
  }

  Future<void> _listen() async {
    if (_ended || _phase == _Phase.muted) return;
    if (!await _rec.hasPermission()) {
      if (mounted) await showError(context, 'Dave needs the microphone to hear you -- allow it in your phone settings.');
      return;
    }
    _heardSpeech = false;
    _quietSince = null;
    _path = '${Directory.systemTemp.path}/dave-call-${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _rec.start(
      const RecordConfig(
        encoder: AudioEncoder.aacLc,
        sampleRate: 16000,
        numChannels: 1,
        bitRate: 48000,
        noiseSuppress: true,
        autoGain: true,
        // Normal mode: recording must not switch the phone into "in a call" audio.
        androidConfig: AndroidRecordConfig(audioSource: AndroidAudioSource.voiceRecognition, audioManagerMode: AudioManagerMode.modeNormal),
      ),
      path: _path!,
    );
    if (!mounted) return;
    setState(() => _phase = _Phase.listening);
    await _amp?.cancel();
    _amp = _rec.onAmplitudeChanged(const Duration(milliseconds: 120)).listen(_onAmp);
    _maxTimer?.cancel();
    _maxTimer = Timer(_maxTurn, () {
      if (_phase == _Phase.listening && _heardSpeech) unawaited(_send());
    });
  }

  void _onAmp(Amplitude a) {
    if (_phase != _Phase.listening) return;
    final db = a.current.isFinite ? a.current : -100.0;
    setState(() => _level = ((db + 60) / 60).clamp(0.0, 1.0));
    if (db > _speechDb) {
      _heardSpeech = true;
      _quietSince = null;
    } else if (_heardSpeech) {
      _quietSince ??= DateTime.now();
      if (DateTime.now().difference(_quietSince!) >= _endOfTurn) unawaited(_send());
    }
  }

  Future<void> _send() async {
    if (_phase != _Phase.listening) return;
    setState(() => _phase = _Phase.thinking);
    _maxTimer?.cancel();
    await _amp?.cancel();
    final path = await _rec.stop() ?? _path;
    if (path == null) return _listen();
    try {
      final bytes = await File(path).readAsBytes();
      unawaited(File(path).delete().catchError((_) => File(path)));
      final r = await widget.api.voiceTurn(bytes);
      if (_ended || !mounted) return;
      final heard = (r['heard'] as String? ?? '').trim();
      final reply = (r['reply'] as String? ?? '').trim();
      if (heard.isEmpty) return await _listen(); // just noise
      setState(() {
        _lines.add((false, heard));
        if (reply.isNotEmpty) _lines.add((true, reply));
      });
      final audio = r['audio'] as String?;
      if (audio == null || audio.isEmpty) {
        if (r['voiceError'] != null && mounted) await showError(context, r['voiceError'] as String);
        return await _listen();
      }
      setState(() => _phase = _Phase.speaking);
      await _player.play(BytesSource(base64Decode(audio), mimeType: r['contentType'] as String? ?? 'audio/mpeg'));
    } catch (e) {
      if (_ended || !mounted) return;
      await showError(context, e);
      return _listen();
    }
  }

  /// Tap while Dave talks: stop him and listen.
  Future<void> _interrupt() async {
    if (_phase != _Phase.speaking) return;
    HapticFeedback.lightImpact();
    await _player.stop();
    await _listen();
  }

  Future<void> _toggleMute() async {
    HapticFeedback.selectionClick();
    if (_phase == _Phase.muted) {
      setState(() => _phase = _Phase.listening);
      await _listen();
    } else if (_phase == _Phase.listening) {
      await _amp?.cancel();
      _maxTimer?.cancel();
      await _rec.stop();
      setState(() => _phase = _Phase.muted);
    }
  }

  Future<void> _end() async {
    _ended = true;
    HapticFeedback.mediumImpact();
    await _player.stop();
    await _rec.stop();
    if (mounted) Navigator.of(context).pop();
  }

  String get _status => switch (_phase) {
        _Phase.listening => _heardSpeech ? 'Listening…' : 'Go ahead, I\'m listening',
        _Phase.thinking => 'Dave is thinking…',
        _Phase.speaking => 'Dave is talking · tap to cut in',
        _Phase.muted => 'Muted',
      };

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secs = _clock.elapsed.inSeconds;
    final ring = switch (_phase) {
      _Phase.listening => 0.35 + _level * 0.65,
      _Phase.speaking => 1.0,
      _ => 0.25,
    };
    return CupertinoPageScaffold(
      backgroundColor: const Color(0xFF0B0D0C),
      child: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.s4, Space.s3, Space.s4, 0),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('Dave', style: TextStyle(color: Color(0xFFFFFFFF), fontSize: 26, fontWeight: FontWeight.w700)),
                  Text('ElevenLabs voice · full Dave', style: TextStyle(color: const Color(0xFFFFFFFF).withValues(alpha: 0.55), fontSize: 14)),
                ]),
              ),
              Text('${(secs ~/ 60).toString().padLeft(2, '0')}:${(secs % 60).toString().padLeft(2, '0')}',
                  style: TextStyle(color: const Color(0xFFFFFFFF).withValues(alpha: 0.8), fontSize: 16, fontFeatures: const [FontFeature.tabularFigures()])),
            ]),
          ),
          Expanded(
            flex: 5,
            child: Center(
              child: GestureDetector(
                onTap: _interrupt,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 140),
                  width: 150 + 60 * ring,
                  height: 150 + 60 * ring,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: look.accent.withValues(alpha: _phase == _Phase.muted ? 0.15 : 0.25 + 0.35 * ring),
                    border: Border.all(color: look.accent.withValues(alpha: 0.8), width: 2),
                  ),
                  child: Center(
                    child: _phase == _Phase.thinking
                        ? const CupertinoActivityIndicator(radius: 16, color: Color(0xFFFFFFFF))
                        : Icon(_phase == _Phase.speaking ? CupertinoIcons.waveform : CupertinoIcons.mic_fill, size: 44, color: const Color(0xFFFFFFFF)),
                  ),
                ),
              ),
            ),
          ),
          Text(_status, style: TextStyle(color: const Color(0xFFFFFFFF).withValues(alpha: 0.8), fontSize: 16)),
          const SizedBox(height: Space.s3),
          Expanded(
            flex: 4,
            child: ListView(
              reverse: true,
              padding: const EdgeInsets.symmetric(horizontal: Space.s4),
              children: [
                for (final (dave, text) in _lines.reversed)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Text(
                      '${dave ? 'Dave' : 'You'}: $text',
                      style: TextStyle(color: const Color(0xFFFFFFFF).withValues(alpha: dave ? 0.95 : 0.6), fontSize: 15, height: 1.35),
                    ),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, Space.s4),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
              _RoundButton(
                icon: _phase == _Phase.muted ? CupertinoIcons.mic_slash_fill : CupertinoIcons.mic_fill,
                label: _phase == _Phase.muted ? 'Unmute' : 'Mute',
                color: const Color(0xFF1E2320),
                onTap: _toggleMute,
              ),
              _RoundButton(icon: CupertinoIcons.phone_down_fill, label: 'End', color: const Color(0xFFD64545), onTap: _end, big: true),
              _RoundButton(icon: CupertinoIcons.hand_raised_fill, label: 'Cut in', color: const Color(0xFF1E2320), onTap: _interrupt),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({required this.icon, required this.label, required this.color, required this.onTap, this.big = false});
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;
  final bool big;

  @override
  Widget build(BuildContext context) {
    final size = big ? 78.0 : 62.0;
    return Semantics(
      button: true,
      label: label,
      child: GestureDetector(
        onTap: onTap,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: size,
            height: size,
            decoration: BoxDecoration(shape: BoxShape.circle, color: color),
            child: Icon(icon, color: const Color(0xFFFFFFFF), size: big ? 32 : 26),
          ),
          const SizedBox(height: 6),
          Text(label, style: TextStyle(color: const Color(0xFFFFFFFF).withValues(alpha: 0.7), fontSize: 13)),
        ]),
      ),
    );
  }
}
