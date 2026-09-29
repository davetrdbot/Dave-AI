import 'package:share_plus/share_plus.dart';
import 'package:file_picker/file_picker.dart';
import 'dart:io';
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:record/record.dart';

import '../api/chat.dart';
import '../api/client.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/pickers.dart';
import '../widgets/setup_drawing.dart';
import '../widgets/rich_message.dart';
import 'chat_timeline.dart';
import '../api/models.dart';
import 'shell.dart';
import '../look.dart';
import 'dave_voice.dart';

/// Talking to Dave -- the same conversation as Telegram, with every step he takes shown live:
/// each tool as it starts and finishes, his thinking, the workers he starts, and Nous's cards
/// with their buttons. A message typed here is answered here; one typed in Telegram shows up too.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, this.picker});

  /// Overridable for tests.
  final Future<ChatPicture?> Function(BuildContext context)? picker;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _timeline = ChatTimeline();
  final _input = TextEditingController();
  final _controlsKey = GlobalKey<_ControlsStripState>();
  final _focus = FocusNode();
  final _pictures = <ChatPicture>[];
  ChatApi? _api;
  ActivityStream? _stream;
  final _subs = <StreamSubscription<Object?>>[];
  bool _loading = true;
  String? _loadError;
  bool _live = false;
  bool _sending = false;
  ChatState? _state;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final api = AppScope.of(context).api;
    if (_api?.base != api.base || _api?.token != api.token) {
      _api?.close();
      _api = ChatApi.of(api);
      unawaited(_load());
    }
  }

  @override
  void dispose() {
    _close();
    _api?.close();
    _rec?.dispose();
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _close() {
    _rebuild?.cancel();
    for (final s in _subs) {
      s.cancel();
    }
    _subs.clear();
    _stream?.close();
    _stream = null;
  }

  Future<void> _load() async {
    final api = _api!;
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final history = await api.history();
      // A turn already under way when the screen opened: replay its steps so far.
      final recent = await api.activity(after: math.max(0, history.latestEventId - 200), feeds: const ['chat']);
      final finished = recent.events.where((e) => e.kind == 'final' || e.kind == 'ask_user' || e.kind == 'error').map((e) => e.turnId).toSet();
      if (!mounted) return;
      setState(() {
        _timeline.loadHistory(history.items);
        for (final e in recent.events) {
          if (e.turnId != null && !finished.contains(e.turnId)) _timeline.apply(e);
        }
        _loading = false;
      });
      _listen(math.max(history.latestEventId, recent.latestEventId));
    } on UnpairedException catch (e) {
      if (mounted) AppScope.of(context).onUnpaired(e.message);
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _loadError = '$e';
        });
      }
    }
  }

  /// A busy turn sends many events a second; the screen redraws at most every 80 ms for them
  /// instead of once per event -- the difference between smooth and stuttering on a phone.
  Timer? _rebuild;
  void _rebuildSoon() {
    if (_rebuild?.isActive ?? false) return;
    _rebuild = Timer(const Duration(milliseconds: 80), () {
      if (mounted) setState(() {});
    });
  }

  void _listen(int after) {
    _close();
    final api = _api!;
    final stream = api.stream(after: after, feeds: const ['chat', 'background']);
    _stream = stream;
    _subs.add(
      stream.events.listen(
        (e) {
          if (!mounted) return;
          if (_timeline.apply(e)) {
            _rebuildSoon();
            if (e.kind == 'final' || e.kind == 'ask_user') HapticFeedback.lightImpact();
          }
          // You spoke to him, so he answers out loud.
          if (_speakTurn != null && e.turnId == _speakTurn && (e.kind == 'final' || e.kind == 'ask_user')) {
            _speakTurn = null;
            _speakReply('${e.data['text'] ?? e.data['question'] ?? ''}');
          }
        },
        onError: (Object err) {
          if (err is UnpairedException && mounted) AppScope.of(context).onUnpaired(err.message);
        },
      ),
    );
    _subs.add(
      stream.connected.listen((live) {
        if (mounted) setState(() => _live = live);
      }),
    );
    _subs.add(
      stream.ready.listen((s) {
        if (mounted) setState(() => _state = s);
      }),
    );
    stream.start();
  }

  bool get _working => _timeline.runningTurn != null || _sending;

  // ---- talking to Dave: record -> Groq Whisper -> send -> his reply read aloud -------------
  /// Created on the first tap of the mic -- the chat never touches the microphone before that.
  AudioRecorder? _rec;
  AudioRecorder get _recorder => _rec ??= AudioRecorder();
  String _mic = 'idle'; // idle | recording | transcribing
  /// The turn started by voice: its answer is read aloud (ElevenLabs / Fish Audio).
  String? _speakTurn;

  Future<void> _toggleMic() async {
    if (_mic == 'transcribing') return;
    if (_mic == 'recording') {
      HapticFeedback.mediumImpact();
      final path = await _recorder.stop();
      setState(() => _mic = 'transcribing');
      try {
        final bytes = path == null ? const <int>[] : await File(path).readAsBytes();
        final text = await _api!.transcribe(bytes, name: 'voice.m4a');
        if (!mounted) return;
        setState(() => _mic = 'idle');
        if (text.isEmpty) {
          await showError(context, "I didn't catch anything -- try again, a bit closer to the mic.");
          return;
        }
        _speakNextTurn = true;
        await _send(text: text);
      } catch (e) {
        if (mounted) {
          setState(() => _mic = 'idle');
          await showError(context, e);
        }
      } finally {
        if (path != null) File(path).delete().ignore();
      }
      return;
    }
    if (!await _recorder.hasPermission()) {
      if (mounted) await showError(context, 'Dave needs the microphone to hear you -- allow it in your phone settings.');
      return;
    }
    await DaveAudio.stop();
    final path = '${Directory.systemTemp.path}/dave-voice-${DateTime.now().millisecondsSinceEpoch}.m4a';
    // 16 kHz mono AAC: what Whisper works at, and small enough to upload in a moment.
    await _recorder.start(const RecordConfig(encoder: AudioEncoder.aacLc, sampleRate: 16000, numChannels: 1, bitRate: 48000), path: path);
    HapticFeedback.mediumImpact();
    if (mounted) setState(() => _mic = 'recording');
  }

  bool _speakNextTurn = false;

  /// Reads a voice turn's answer aloud in Dave's voice.
  Future<void> _speakReply(String text) async {
    if (text.trim().isEmpty) return;
    try {
      final r = await AppScope.of(context).api.voiceAction({'action': 'speak', 'text': text});
      await DaveAudio.play('${r['audio']}', id: 'reply-${text.hashCode}');
    } catch (e) {
      if (mounted) await showError(context, e);
    }
  }

  Future<void> _send({String? text, bool whenFree = false}) async {
    final api = _api;
    if (api == null) return;
    final message = (text ?? _input.text).trim();
    final pictures = text == null ? List.of(_pictures) : <ChatPicture>[];
    if (message.isEmpty && pictures.isEmpty) return;
    HapticFeedback.selectionClick();
    final pending = _timeline.addPending(message, pictures.length);
    setState(() {
      _sending = true;
      if (text == null) {
        _input.clear();
        _pictures.clear();
      }
    });
    try {
      final turnId = await api.send(message, pictures: pictures, whenFree: whenFree);
      if (!mounted) return;
      setState(() => _timeline.confirmPending(pending, turnId));
      if (_speakNextTurn) _speakTurn = turnId;
      _speakNextTurn = false;
    } on DaveBusyException catch (busy) {
      if (!mounted) return;
      setState(() => _timeline.entries.remove(pending));
      final choice = await _askWhatToDo(busy.task);
      if (!mounted) return;
      if (choice == null) {
        // Put it back so nothing typed is lost.
        if (text == null) {
          _input.text = message;
          _pictures.addAll(pictures);
        }
        setState(() {});
        return;
      }
      if (choice == 'stop') await _stop(quiet: true);
      if (text == null) {
        _input.text = message;
        _pictures.addAll(pictures);
      }
      await _send(text: text, whenFree: true);
      return;
    } on UnpairedException catch (e) {
      if (mounted) AppScope.of(context).onUnpaired(e.message);
    } catch (e) {
      if (mounted) setState(() => _timeline.failPending(pending, '$e'));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<String?> _askWhatToDo(String? task) => showCupertinoModalPopup<String>(
    context: context,
    builder: (ctx) => CupertinoActionSheet(
      title: const Text('Dave is busy'),
      message: Text(task == null || task.isEmpty ? 'He is in the middle of something else.' : 'He is working on: $task'),
      actions: [
        CupertinoActionSheetAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, 'stop'), child: const Text('Stop it and send mine')),
        CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'queue'), child: const Text('Send when he is free')),
      ],
      cancelButton: CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
    ),
  );

  Future<void> _stop({bool quiet = false}) async {
    HapticFeedback.mediumImpact();
    try {
      await _api?.stop();
    } catch (e) {
      if (!quiet && mounted) _toast('Could not stop: $e');
    }
  }

  Future<void> _attach() async {
    final picker = widget.picker ?? _pickPicture;
    final picture = await picker(context);
    if (picture == null || !mounted) return;
    setState(() => _pictures.add(picture));
  }

  /// Any file -- a CSV export, a PDF, an .mq5, a screenshot -- goes to Dave's inbox; his scripts
  /// can open it and he can send a result back.
  Future<void> _pickDocument() async {
    try {
      final picked = await FilePicker.pickFiles();
      if (!mounted) return;
      for (final f in picked.take(5)) {
        final size = await f.length();
        if (size != null && size > 20 * 1024 * 1024) {
          _toast('${f.name} is over 20 MB.');
          continue;
        }
        final bytes = await f.readAsBytes();
        if (!mounted) return;
        setState(() => _pictures.add(ChatPicture(bytes, mediaType: 'application/octet-stream', name: f.name)));
      }
    } catch (e) {
      if (mounted) _toast('Could not open that file: $e');
    }
  }

  Future<ChatPicture?> _pickPicture(BuildContext context) async {
    final source = await showCupertinoModalPopup<ImageSource>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        actions: [
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, ImageSource.camera), child: const Text('Take a photo')),
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, ImageSource.gallery), child: const Text('Choose from library')),
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(ctx);
              _pickDocument();
            },
            child: const Text('Send a file'),
          ),
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(ctx);
              // A setup: a trade that waits for price to do something first.
              _input.text = 'Setup: if XAUUSD goes above ____ and then comes back below ____, buy with SL ____ and TP ____. If it goes below ____ first, cancel.';
              _focus.requestFocus();
            },
            child: const Text('Write a setup'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
      ),
    );
    if (source == null) return null;
    try {
      // Shrunk on the phone: a chart screenshot reads fine at 1600px, and it uploads in a moment.
      final file = await ImagePicker().pickImage(source: source, maxWidth: 1600, maxHeight: 1600, imageQuality: 82);
      if (file == null) return null;
      final bytes = await file.readAsBytes();
      final png = file.name.toLowerCase().endsWith('.png');
      return ChatPicture(bytes, mediaType: png ? 'image/png' : 'image/jpeg');
    } catch (e) {
      if (mounted) _toast('Could not open that picture: $e');
      return null;
    }
  }

  Future<void> _tapCardButton(CardEntry card, CardButton button) async {
    final api = _api;
    if (api == null || button.callback == null) return;
    HapticFeedback.selectionClick();
    setState(() => card.used = button.callback);
    try {
      final result = await api.action(button.callback!, messageId: (card.event.data['id'] as num?)?.toInt());
      if (mounted) setState(() => card.result = result);
    } catch (e) {
      if (mounted) {
        setState(() {
          card.used = null;
          card.result = 'Did not go through: $e';
        });
      }
    }
  }

  void _toast(String text) {
    showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        content: Text(text),
        actions: [CupertinoDialogAction(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
  }

  String get _status {
    if (!_live && !_loading && _loadError == null) return 'Connecting…';
    final running = _timeline.runningTurn;
    if (running != null) {
      final tool = running.tools.where((s) => s.running).lastOrNull;
      return tool != null ? '${tool.label}…' : 'Thinking…';
    }
    if (_state?.busy == true) return 'Busy: ${_state!.task ?? 'working'}';
    return 'Online';
  }

  @override
  Widget build(BuildContext context) {
    final keyboard = MediaQuery.viewInsetsOf(context).bottom > 0;
    // Chat is full screen -- no tab bar under it -- so the composer only clears the home indicator.
    final bottomClearance = keyboard ? Space.s2 : Space.s2 + MediaQuery.paddingOf(context).bottom;
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      navigationBar: CupertinoNavigationBar(
        heroTag: 'nav:Chat',
        transitionBetweenRoutes: false,
        border: null,
        leading: CupertinoButton(
          padding: EdgeInsets.zero,
          onPressed: () => ShellScope.of(context)?.goTo(ShellScope.home),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(CupertinoIcons.chevron_back, color: Look.of(context).accent),
            Text('Home', style: TextStyle(color: Look.of(context).accent)),
          ]),
        ),
        middle: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Dave'),
            Text(
              _status,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w400, color: resolve(context, _live ? CupertinoColors.secondaryLabel : CupertinoColors.systemOrange)),
            ),
          ],
        ),
        trailing: _working
            ? CupertinoButton(
                padding: EdgeInsets.zero,
                onPressed: _stop,
                child: const Text('Stop', style: TextStyle(fontWeight: FontWeight.w600)),
              )
            : null,
      ),
      child: SafeArea(
        bottom: false,
        child: Column(
          children: [
            _ControlsStrip(key: _controlsKey),
            // The conversation sits in a rounded panel under the controls.
            Expanded(
              child: Container(
                margin: const EdgeInsets.fromLTRB(Space.s2, Space.s1, Space.s2, Space.s2),
                decoration: BoxDecoration(
                  color: Look.of(context).card.withValues(alpha: Look.of(context).dark ? 0.55 : 0.6),
                  borderRadius: BorderRadius.circular(28),
                  border: Border.all(color: Look.of(context).line),
                ),
                clipBehavior: Clip.antiAlias,
                child: _body(),
              ),
            ),
            _Composer(
              controller: _input,
              focus: _focus,
              pictures: _pictures,
              working: _working,
              onSend: () => _send(),
              onStop: _stop,
              onAttach: _attach,
              onRemovePicture: (i) => setState(() => _pictures.removeAt(i)),
              mic: _mic,
              onMic: _toggleMic,
            ),
            SizedBox(height: bottomClearance),
          ],
        ),
      ),
    );
  }

  Widget _body() {
    if (_loading) return const Center(child: CupertinoActivityIndicator(radius: 14));
    if (_loadError != null) {
      return Center(
        child: EmptyState(
          icon: CupertinoIcons.chat_bubble_2,
          title: 'Could not open the chat',
          message: _loadError!,
          action: CupertinoButton.filled(onPressed: _load, child: const Text('Try again')),
        ),
      );
    }
    final entries = _timeline.entries;
    if (entries.isEmpty) {
      return const Center(
        child: EmptyState(icon: CupertinoIcons.chat_bubble_2, title: 'Talk to Dave', message: 'Ask about the market, your trades or anything else. You will see every step he takes, live.'),
      );
    }
    return GestureDetector(
      onTap: () => _focus.unfocus(),
      child: ListView.builder(
        reverse: true,
        padding: const EdgeInsets.fromLTRB(Space.s3, Space.s3, Space.s3, Space.s2),
        itemCount: entries.length,
        // Keyed, so a new message doesn't shift and rebuild every one already on screen.
        findChildIndexCallback: (key) {
          final i = entries.indexWhere((e) => ObjectKey(e) == key);
          return i < 0 ? null : entries.length - 1 - i;
        },
        itemBuilder: (context, i) {
          final entry = entries[entries.length - 1 - i];
          return KeyedSubtree(key: ObjectKey(entry), child: switch (entry) {
            HistoryEntry(:final item) => _HistoryBubble(item),
            TurnEntry() => _TurnView(
              turn: entry,
              onOption: (o) => _send(text: o),
              onCardButton: _tapCardButton,
            ),
            CardEntry() => _CardView(card: entry, onButton: _tapCardButton),
          });
        },
      ),
    );
  }
}

// --- the pieces -------------------------------------------------------------------------------

class _Bubble extends StatelessWidget {
  const _Bubble({required this.fromUser, required this.child, this.caption});
  final bool fromUser;
  final Widget child;
  final String? caption;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Column(
        crossAxisAlignment: fromUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          ConstrainedBox(
            constraints: BoxConstraints(maxWidth: width * (fromUser ? 0.78 : 0.9)),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: fromUser
                  ? BoxDecoration(
                      borderRadius: const BorderRadius.only(topLeft: Radius.circular(18), topRight: Radius.circular(18), bottomLeft: Radius.circular(18), bottomRight: Radius.circular(5)),
                      gradient: Look.of(context).me,
                    )
                  : glassDecoration(context, radius: 18),
              child: child,
            ),
          ),
          if (caption != null)
            Padding(
              padding: const EdgeInsets.only(top: 2, left: 8, right: 8),
              child: Text(caption!, style: TextStyle(fontSize: 11, color: resolve(context, CupertinoColors.tertiaryLabel))),
            ),
        ],
      ),
    );
  }
}

class _UserText extends StatelessWidget {
  const _UserText(this.text, this.pictures);
  final String text;
  final int pictures;
  @override
  Widget build(BuildContext context) {
    final white = Look.of(context).meText;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (pictures > 0)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(CupertinoIcons.photo, size: 15, color: white),
              const SizedBox(width: 5),
              Text(pictures == 1 ? 'Picture' : '$pictures pictures', style: TextStyle(fontSize: 13, color: white)),
            ],
          ),
        if (text.isNotEmpty) Text(text, style: TextStyle(fontSize: 14.5, height: 1.35, color: white, letterSpacing: -0.1)),
      ],
    );
  }
}

class _HistoryBubble extends StatelessWidget {
  const _HistoryBubble(this.item);
  final ChatHistoryItem item;
  @override
  Widget build(BuildContext context) {
    if (item.fromUser) return _Bubble(fromUser: true, child: _UserText(_stripContext(item.text), item.pictures));
    final text = _looksHtml(item.text) ? htmlToMarkdown(item.text) : item.text;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _Bubble(
        fromUser: false,
        caption: item.tools.isEmpty ? null : 'Used ${item.tools.length} tool${item.tools.length == 1 ? '' : 's'}',
        child: MarkdownText(text, fontSize: 14.5),
      ),
      if (text.trim().isNotEmpty) _SpeakButton(text: text),
    ]);
  }
}

/// Dave's stored user messages carry the live context (time, account) he was given -- the
/// trader typed only the part before it.
String _stripContext(String text) {
  final i = text.indexOf('\n\n[');
  return i > 0 ? text.substring(0, i).trim() : text.trim();
}

bool _looksHtml(String s) => RegExp(r'</?(b|i|code|pre|br|a)\b', caseSensitive: false).hasMatch(s);

class _TurnView extends StatelessWidget {
  const _TurnView({required this.turn, required this.onOption, required this.onCardButton});
  final TurnEntry turn;
  final void Function(String option) onOption;
  final Future<void> Function(CardEntry card, CardButton button) onCardButton;

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    if (turn.userText.isNotEmpty || turn.pictures > 0) {
      children.add(_Bubble(fromUser: true, caption: turn.pending ? 'Sending…' : (turn.fromTelegram ? 'via Telegram' : null), child: _UserText(turn.userText, turn.pictures)));
    }
    if (turn.steps.isNotEmpty || (turn.running && !turn.pending)) children.add(_WorkingCard(turn: turn, onCardButton: onCardButton));
    if (turn.notice != null && turn.running) children.add(_Note(turn.notice!));
    final reply = turn.finalText ?? '';
    if (reply.trim().isNotEmpty) {
      children.add(_Bubble(fromUser: false, caption: turn.tokens == null ? null : '${_compact(turn.tokens!)} tokens', child: MarkdownText(_looksHtml(reply) ? htmlToMarkdown(reply) : reply, fontSize: 14.5)));
      if (!turn.running) children.add(_SpeakButton(text: _looksHtml(reply) ? htmlToMarkdown(reply) : reply));
    }
    if (turn.question != null) {
      children.add(_Bubble(fromUser: false, child: MarkdownText(turn.question!, fontSize: 14.5)));
      if (turn.options.isNotEmpty) {
        children.add(
          Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 4),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final o in turn.options)
                  CupertinoButton(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                    minimumSize: const Size(0, 36),
                    color: Look.of(context).accent.withValues(alpha: 0.13),
                    borderRadius: BorderRadius.circular(18),
                    onPressed: () => onOption(o),
                    child: Text(
                      o,
                      style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: Look.of(context).accent),
                    ),
                  ),
              ],
            ),
          ),
        );
      }
    }
    if (turn.error != null) children.add(_Note(turn.error!, warning: true));
    // New steps and the reply grow the turn smoothly instead of making the list jump.
    return AnimatedSize(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      alignment: Alignment.topCenter,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}

String _compact(int n) => n >= 1000 ? '${(n / 1000).toStringAsFixed(n >= 10000 ? 0 : 1)}k' : '$n';

class _Note extends StatelessWidget {
  const _Note(this.text, {this.warning = false});
  final String text;
  final bool warning;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(fontSize: 13, height: 1.3, color: resolve(context, warning ? CupertinoColors.systemRed : CupertinoColors.secondaryLabel)),
    ),
  );
}

/// "Dave is working": each step as it happens. Folds into one line once he has answered.
class _WorkingCard extends StatefulWidget {
  const _WorkingCard({required this.turn, required this.onCardButton});
  final TurnEntry turn;
  final Future<void> Function(CardEntry card, CardButton button) onCardButton;
  @override
  State<_WorkingCard> createState() => _WorkingCardState();
}

class _WorkingCardState extends State<_WorkingCard> {
  bool? _open;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (widget.turn.running && mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final turn = widget.turn;
    final open = _open ?? turn.running;
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final tools = turn.tools.length;
    final elapsed = DateTime.now().difference(turn.startedAt).inSeconds;
    final summary = turn.running
        ? 'Working${tools > 0 ? ' · $tools step${tools == 1 ? '' : 's'}' : ''} · ${elapsed}s'
        : '${turn.stopped != null ? 'Stopped' : 'Done'} · $tools step${tools == 1 ? '' : 's'}${turn.thoughts.isNotEmpty ? ' · thought it through' : ''}';
    final cards = turn.steps.where((s) => s.kind == 'card').toList();
    final todos = _latestTodos(turn);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            decoration: glassDecoration(context, radius: 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => toggleKeepingPlace(context, () => setState(() => _open = !open)),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                    child: Row(
                      children: [
                        if (turn.running)
                          const CupertinoActivityIndicator(radius: 7)
                        else
                          Icon(turn.stopped != null ? CupertinoIcons.stop_circle : CupertinoIcons.checkmark_circle, size: 16, color: secondary),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            summary,
                            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: secondary),
                          ),
                        ),
                        Icon(open ? CupertinoIcons.chevron_up : CupertinoIcons.chevron_down, size: 13, color: secondary),
                      ],
                    ),
                  ),
                ),
                // The to-do list stays in view, folded or not: it is the plan he's working through.
                if (todos != null) _TodoChecklist(items: todos, running: turn.running),
                if (open)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (final s in turn.steps)
                          if (s.kind == 'tool')
                            _ToolRow(step: s)
                          else if (s.kind == 'thinking')
                            _ThinkingRow(step: s)
                          else if (s.kind == 'text')
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 4),
                              child: MarkdownText(s.text, fontSize: 13.5, color: secondary),
                            ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          // Messages Dave sent during the turn (tables, cards) stay visible even when folded.
          for (final c in cards) _CardView(card: c.card!, onButton: widget.onCardButton),
        ],
      ),
    );
  }
}

/// The newest state of Dave's to-do list in this turn (from `update_todos`), or null.
List<Map<String, dynamic>>? _latestTodos(TurnEntry turn) {
  for (final s in turn.steps.reversed) {
    if (s.kind != 'tool' || s.name != 'update_todos') continue;
    final result = s.result;
    final args = s.args;
    final raw = (result is Map && result['todos'] is List)
        ? result['todos'] as List
        : (args is Map && args['todos'] is List)
            ? args['todos'] as List
            : null;
    if (raw == null) continue;
    final items = raw.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
    if (items.isNotEmpty) return items;
  }
  return null;
}

class _TodoChecklist extends StatelessWidget {
  const _TodoChecklist({required this.items, required this.running});
  final List<Map<String, dynamic>> items;
  final bool running;

  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final label = resolve(context, CupertinoColors.label);
    final done = items.where((t) => t['status'] == 'done').length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('To-do list', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: secondary)),
              const Spacer(),
              Text('$done of ${items.length} done', style: TextStyle(fontSize: 12, color: secondary, fontFeatures: const [FontFeature.tabularFigures()])),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: Container(
              height: 3,
              color: resolve(context, CupertinoColors.systemFill),
              alignment: Alignment.centerLeft,
              child: FractionallySizedBox(
                widthFactor: items.isEmpty ? 0 : done / items.length,
                child: Container(color: resolve(context, CupertinoColors.systemGreen)),
              ),
            ),
          ),
          const SizedBox(height: 4),
          for (final t in items) _todoRow(context, t, label, secondary),
        ],
      ),
    );
  }

  Widget _todoRow(BuildContext context, Map<String, dynamic> t, Color label, Color secondary) {
    final status = t['status'] as String? ?? 'pending';
    final note = (t['note'] as String?)?.trim();
    final Widget icon = switch (status) {
      'done' => Icon(CupertinoIcons.checkmark_circle_fill, size: 16, color: resolve(context, CupertinoColors.systemGreen)),
      'blocked' => Icon(CupertinoIcons.exclamationmark_circle_fill, size: 16, color: resolve(context, CupertinoColors.systemOrange)),
      'in_progress' => running ? const CupertinoActivityIndicator(radius: 6) : Icon(CupertinoIcons.circle_lefthalf_fill, size: 16, color: resolve(context, CupertinoColors.systemBlue)),
      _ => Icon(CupertinoIcons.circle, size: 16, color: resolve(context, CupertinoColors.tertiaryLabel)),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 18, height: 18, child: Center(child: icon)),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${t['text'] ?? ''}',
                  style: TextStyle(
                    fontSize: 13.5,
                    height: 1.3,
                    fontWeight: status == 'in_progress' ? FontWeight.w600 : FontWeight.w400,
                    color: status == 'done' ? secondary : label,
                  ),
                ),
                if (note != null && note.isNotEmpty) Text(note, style: TextStyle(fontSize: 12, height: 1.3, color: secondary)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ToolRow extends StatefulWidget {
  const _ToolRow({required this.step});
  final TurnStep step;
  @override
  State<_ToolRow> createState() => _ToolRowState();
}

class _ToolRowState extends State<_ToolRow> {
  bool _open = false;
  @override
  Widget build(BuildContext context) {
    final s = widget.step;
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final Widget icon = s.running
        ? const CupertinoActivityIndicator(radius: 6)
        : Icon(
            s.isError ? CupertinoIcons.xmark_circle_fill : CupertinoIcons.checkmark_circle_fill,
            size: 15,
            color: resolve(context, s.isError ? CupertinoColors.systemRed : CupertinoColors.systemGreen),
          );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => toggleKeepingPlace(context, () => setState(() => _open = !_open)),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: [
                SizedBox(width: 18, child: Center(child: icon)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: _sentence(s.label),
                          style: TextStyle(fontSize: 13.5, color: resolve(context, CupertinoColors.label)),
                        ),
                        if (s.agent != null)
                          TextSpan(
                            text: '  ${s.agent}',
                            style: TextStyle(fontSize: 12, color: secondary),
                          ),
                      ],
                    ),
                  ),
                ),
                if (s.ms != null)
                  Text(
                    _duration(s.ms!),
                    style: TextStyle(fontSize: 12, color: secondary, fontFeatures: const [FontFeature.tabularFigures()]),
                  ),
              ],
            ),
          ),
        ),
        if (_open)
          Padding(
            padding: const EdgeInsets.only(left: 26, bottom: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.name,
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: secondary),
                ),
                if (s.args != null && s.args is Map && (s.args as Map).isNotEmpty) ...[const SizedBox(height: 4), CodeBox(_pretty(s.args))],
                if (s.result != null) ...[const SizedBox(height: 4), CodeBox(_pretty(s.result))],
              ],
            ),
          ),
      ],
    );
  }
}

class _ThinkingRow extends StatelessWidget {
  const _ThinkingRow({required this.step});
  final TurnStep step;
  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Details(
        title: step.agent == null ? 'Thinking' : 'Thinking · ${step.agent}',
        child: Text(
          step.text,
          style: TextStyle(fontSize: 12.5, height: 1.4, fontStyle: FontStyle.italic, color: secondary),
        ),
      ),
    );
  }
}

String _sentence(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

String _duration(int ms) => ms < 1000 ? '${ms}ms' : (ms < 60000 ? '${(ms / 1000).toStringAsFixed(1)}s' : '${ms ~/ 60000}m ${(ms % 60000) ~/ 1000}s');

String _pretty(Object? v) {
  if (v is String) return v;
  try {
    return const JsonEncoder.withIndent('  ').convert(v);
  } catch (_) {
    return '$v';
  }
}

/// A card or note: a message a tool sent, a Nous signal with its buttons, a worker's report.
class _CardView extends StatelessWidget {
  const _CardView({required this.card, required this.onButton});
  final CardEntry card;
  final Future<void> Function(CardEntry card, CardButton button) onButton;

  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final e = card.event;
    final (IconData? icon, String? label) = switch (card.kind) {
      'nous_card' || 'nous_note' => (CupertinoIcons.antenna_radiowaves_left_right, 'Nous'),
      'worker_report' || 'worker_done' => (CupertinoIcons.person_2, e.text('name').isEmpty ? 'Worker' : e.text('name')),
      'alert' => (CupertinoIcons.exclamationmark_triangle, 'Alert'),
      'scalp' => (CupertinoIcons.arrow_2_squarepath, 'Scalp'),
      'trade_closed' || 'trade_modified' => (CupertinoIcons.chart_bar_alt_fill, 'Trade'),
      _ => (null, null),
    };
    if (card.kind == 'file') return _FileCard(event: e);
    if (card.kind == 'drawing' && e.data['drawing'] is Map) {
      return Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: SetupDrawingView(drawing: Map<String, dynamic>.from(e.data['drawing'] as Map)));
    }
    Widget body;
    if (card.blocks.isNotEmpty) {
      body = RichBlocks(card.blocks);
    } else if (card.html.isNotEmpty) {
      body = MarkdownText(htmlToMarkdown(card.html));
    } else {
      final t = card.text;
      body = MarkdownText(_looksHtml(t) || e.text('format') == 'html' ? htmlToMarkdown(t) : t);
    }
    final buttons = parseButtons(card.buttons);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
        decoration: glassDecoration(context, radius: 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (label != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  children: [
                    Icon(icon, size: 13, color: secondary),
                    const SizedBox(width: 5),
                    Text(
                      label.toUpperCase(),
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, letterSpacing: 0.4, color: secondary),
                    ),
                    const Spacer(),
                    Text(formatAgo(e.at), style: TextStyle(fontSize: 11.5, color: resolve(context, CupertinoColors.tertiaryLabel))),
                  ],
                ),
              ),
            body,
            if (buttons.isNotEmpty) CardButtons(rows: buttons, used: card.used, onTap: (b) => onButton(card, b)),
            if (card.result != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(card.result!, style: TextStyle(fontSize: 13, color: secondary)),
              ),
          ],
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.focus,
    required this.pictures,
    required this.working,
    required this.onSend,
    required this.onStop,
    required this.onAttach,
    required this.onRemovePicture,
    this.mic = 'idle',
    this.onMic,
  });
  /// idle | recording | transcribing
  final String mic;
  final VoidCallback? onMic;
  final TextEditingController controller;
  final FocusNode focus;
  final List<ChatPicture> pictures;
  final bool working;
  final VoidCallback onSend;
  final VoidCallback onStop;
  final VoidCallback onAttach;
  final void Function(int index) onRemovePicture;

  @override
  Widget build(BuildContext context) {
    final blue = Look.of(context).accent;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.s3, Space.s1, Space.s3, 0),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (pictures.isNotEmpty)
            SizedBox(
              height: 64,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: pictures.length,
                separatorBuilder: (_, _) => const SizedBox(width: 6),
                itemBuilder: (context, i) => Stack(
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: pictures[i].isDocument
                          ? Container(
                              width: 110,
                              height: 58,
                              padding: const EdgeInsets.all(6),
                              color: Look.of(context).chip,
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Icon(CupertinoIcons.doc_fill, size: 18, color: Look.of(context).accent),
                                const SizedBox(height: 3),
                                Text(pictures[i].name!, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600)),
                              ]),
                            )
                          : Image.memory(Uint8List.fromList(pictures[i].bytes), width: 58, height: 58, fit: BoxFit.cover),
                    ),
                    Positioned(
                      right: 0,
                      top: 0,
                      child: GestureDetector(
                        onTap: () => onRemovePicture(i),
                        child: const Icon(CupertinoIcons.xmark_circle_fill, size: 20, color: CupertinoColors.white),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          Glass(
            radius: 16,
            color: Look.of(context).card,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 3, 4, 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Semantics(
                    button: true,
                    label: 'Add',
                    child: GestureDetector(
                      onTap: onAttach,
                      child: Container(
                        width: 32,
                        height: 32,
                        margin: const EdgeInsets.only(bottom: 2),
                        decoration: BoxDecoration(color: Look.of(context).chip, borderRadius: BorderRadius.circular(10)),
                        child: Icon(CupertinoIcons.add, size: 18, color: blue),
                      ),
                    ),
                  ),
                  Expanded(
                    child: CupertinoTextField(
                      controller: controller,
                      focusNode: focus,
                      placeholder: mic == 'recording' ? 'Listening... tap the red button to send' : mic == 'transcribing' ? 'Turning your voice into text...' : 'Message Dave',
                      minLines: 1,
                      maxLines: 6,
                      textCapitalization: TextCapitalization.sentences,
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      style: TextStyle(fontSize: 15, color: resolve(context, CupertinoColors.label)),
                      decoration: null,
                    ),
                  ),
                  const SizedBox(width: 6),
                  ValueListenableBuilder<TextEditingValue>(
                    valueListenable: controller,
                    builder: (context, value, _) {
                      final canSend = value.text.trim().isNotEmpty || pictures.isNotEmpty;
                      if (mic == 'recording') {
                        return _RoundButton(key: const ValueKey('mic-stop'), icon: CupertinoIcons.stop_fill, color: resolve(context, CupertinoColors.systemRed), semantic: 'Stop recording and send', onTap: onMic);
                      }
                      if (mic == 'transcribing') {
                        return const SizedBox(width: 34, height: 34, child: Center(child: CupertinoActivityIndicator(radius: 9)));
                      }
                      if (!canSend && !working && onMic != null) {
                        return _RoundButton(key: const ValueKey('mic'), icon: CupertinoIcons.mic_fill, color: blue, semantic: 'Talk to Dave', onTap: onMic);
                      }
                      if (working && !canSend) {
                        return _RoundButton(icon: CupertinoIcons.stop_fill, color: Look.of(context).down, semantic: 'Stop', onTap: onStop);
                      }
                      return _RoundButton(icon: CupertinoIcons.arrow_up, color: canSend ? blue : resolve(context, CupertinoColors.systemGrey3), semantic: 'Send', onTap: canSend ? onSend : null);
                    },
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({super.key, required this.icon, required this.color, required this.semantic, this.onTap});
  final IconData icon;
  final Color color;
  final String semantic;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: semantic,
    child: GestureDetector(
      onTap: onTap,
      child: Container(
        width: 32,
        height: 32,
        margin: const EdgeInsets.only(bottom: 2),
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(10)),
        child: Icon(icon, size: 17, color: color == Look.of(context).accent ? Look.of(context).tabActiveIcon : CupertinoColors.white),
      ),
    ),
  );
}


/// Under the header: the AI Dave is using right now, and the stop loss / take profit he trades
/// with -- each one tap to change, without leaving the chat.
class _ControlsStrip extends StatefulWidget {
  const _ControlsStrip({super.key});
  @override
  State<_ControlsStrip> createState() => _ControlsStripState();
}

class _ControlsStripState extends State<_ControlsStrip> {
  ProviderList? _providers;
  AppSettings? _settings;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final api = AppScope.of(context).api;
    try {
      final r = await Future.wait([api.providers(), api.settings()]);
      if (!mounted) return;
      setState(() {
        _providers = r[0] as ProviderList;
        _settings = r[1] as AppSettings;
      });
    } catch (_) {
      // the strip just stays empty; the chat works without it
    }
  }

  Future<void> _pickModel() async {
    final list = _providers;
    if (list == null) return;
    if (await showAiSheet(context, list) && mounted) await _load();
  }

  Future<void> _risk(String id, String title, RiskMode mode) async {
    final changed = await showRiskModeSheet(context, id: id, title: title, icon: id == 'takeProfit' ? CupertinoIcons.flag : CupertinoIcons.shield, mode: mode);
    if (changed == true) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final main = _providers?.main;
    final s = _settings;
    Widget chip(IconData icon, String label, VoidCallback? onTap, {bool strong = false}) => GestureDetector(
          onTap: onTap == null
              ? null
              : () {
                  HapticFeedback.selectionClick();
                  onTap();
                },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
            decoration: BoxDecoration(color: strong ? look.accent.withValues(alpha: 0.16) : look.chip, borderRadius: BorderRadius.circular(16), border: Border.all(color: look.line)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 14, color: strong ? look.accent : resolve(context, CupertinoColors.secondaryLabel)),
              const SizedBox(width: 5),
              Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: strong ? look.accent : resolve(context, CupertinoColors.label))),
            ]),
          ),
        );
    return SizedBox(
      height: 42,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(Space.s3, 4, Space.s3, 4),
        children: [
          chip(CupertinoIcons.sparkles, main == null ? 'AI…' : main.model.split('/').last, _providers == null ? null : _pickModel, strong: true),
          const SizedBox(width: 6),
          if (s != null) ...[
            chip(CupertinoIcons.shield, 'SL ${s.stopLoss.summary}', () => _risk('stopLoss', 'Stop loss', s.stopLoss)),
            const SizedBox(width: 6),
            chip(CupertinoIcons.flag, 'TP ${s.takeProfit.summary}', () => _risk('takeProfit', 'Take profit', s.takeProfit)),
          ],
        ],
      ),
    );
  }
}

/// A file Dave sent: name, size, his note -- tap to download it and open or share it.
class _FileCard extends StatefulWidget {
  const _FileCard({required this.event});
  final ActivityEvent event;

  @override
  State<_FileCard> createState() => _FileCardState();
}

class _FileCardState extends State<_FileCard> {
  bool _busy = false;
  String? _error;

  Future<void> _open() async {
    final scope = AppScope.of(context);
    setState(() => (_busy = true, _error = null));
    try {
      final bytes = await ChatApi.of(scope.api).downloadFile(widget.event.text('id'));
      final dir = await Directory.systemTemp.createTemp('dave-');
      final file = File('${dir.path}/${widget.event.text('name')}');
      await file.writeAsBytes(bytes);
      await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: widget.event.text('mime'))], text: widget.event.text('caption').isEmpty ? null : widget.event.text('caption')));
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final e = widget.event;
    final kb = ((e.data['bytes'] as num?) ?? 0) / 1024;
    final size = kb >= 1024 ? '${(kb / 1024).toStringAsFixed(1)} MB' : '${math.max(1, kb.round())} KB';
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return GestureDetector(
      key: ValueKey('file-${e.text('id')}'),
      onTap: _busy ? null : _open,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(Space.s3),
        decoration: glassDecoration(context, radius: 16),
        child: Row(children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(color: look.accent.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(12)),
            child: Icon(CupertinoIcons.doc_text_fill, color: look.accent),
          ),
          const SizedBox(width: Space.s3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(e.text('name'), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
              Text(_error ?? [size, if (e.text('caption').isNotEmpty) e.text('caption')].join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: _error != null ? look.down : secondary)),
            ]),
          ),
          _busy ? const CupertinoActivityIndicator() : Icon(CupertinoIcons.arrow_down_circle_fill, color: look.accent, size: 26),
        ]),
      ),
    );
  }
}

/// "Listen": Dave reads this reply aloud in his ElevenLabs / Fish Audio voice.
class _SpeakButton extends StatefulWidget {
  const _SpeakButton({required this.text});
  final String text;

  @override
  State<_SpeakButton> createState() => _SpeakButtonState();
}

class _SpeakButtonState extends State<_SpeakButton> {
  bool _loading = false;
  String get _id => 'reply-${widget.text.hashCode}';

  Future<void> _tap(bool playing) async {
    if (playing) return DaveAudio.stop();
    setState(() => _loading = true);
    try {
      final r = await AppScope.of(context).api.voiceAction({'action': 'speak', 'text': widget.text});
      await DaveAudio.play('${r['audio']}', id: _id);
    } catch (e) {
      if (mounted) await showError(context, e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Align(
      alignment: Alignment.centerLeft,
      child: ValueListenableBuilder<String?>(
        valueListenable: DaveAudio.playing,
        builder: (context, playing, _) {
          final on = playing == _id;
          return CupertinoButton(
            padding: const EdgeInsets.only(left: 10, top: 2, bottom: 2),
            minimumSize: const Size(0, 28),
            onPressed: _loading ? null : () => _tap(on),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              _loading ? const CupertinoActivityIndicator(radius: 7) : Icon(on ? CupertinoIcons.stop_circle_fill : CupertinoIcons.speaker_2_fill, size: 16, color: look.accent),
              const SizedBox(width: 5),
              Text(on ? 'Stop' : 'Listen', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: look.accent)),
            ]),
          );
        },
      ),
    );
  }
}
