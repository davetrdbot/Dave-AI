import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import '../api/chat.dart';
import '../api/client.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/rich_message.dart';
import 'chat_timeline.dart';

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
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _close() {
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

  void _listen(int after) {
    _close();
    final api = _api!;
    final stream = api.stream(after: after, feeds: const ['chat', 'background']);
    _stream = stream;
    _subs.add(stream.events.listen((e) {
      if (!mounted) return;
      if (_timeline.apply(e)) {
        setState(() {});
        if (e.kind == 'final' || e.kind == 'ask_user') HapticFeedback.lightImpact();
      }
    }, onError: (Object err) {
      if (err is UnpairedException && mounted) AppScope.of(context).onUnpaired(err.message);
    }));
    _subs.add(stream.connected.listen((live) {
      if (mounted) setState(() => _live = live);
    }));
    _subs.add(stream.ready.listen((s) {
      if (mounted) setState(() => _state = s);
    }));
    stream.start();
  }

  bool get _working => _timeline.runningTurn != null || _sending;

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

  Future<ChatPicture?> _pickPicture(BuildContext context) async {
    final source = await showCupertinoModalPopup<ImageSource>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        actions: [
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, ImageSource.camera), child: const Text('Take a photo')),
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, ImageSource.gallery), child: const Text('Choose from library')),
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
      builder: (ctx) => CupertinoAlertDialog(content: Text(text), actions: [CupertinoDialogAction(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))]),
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
    final bottomClearance = keyboard ? Space.s2 : 62 + 12 + Space.s2 + MediaQuery.paddingOf(context).bottom;
    return CupertinoPageScaffold(
      backgroundColor: resolve(context, CupertinoColors.systemGroupedBackground),
      navigationBar: CupertinoNavigationBar(
        heroTag: 'nav:Chat',
        transitionBetweenRoutes: false,
        middle: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Dave'),
          Text(_status, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w400, color: resolve(context, _live ? CupertinoColors.secondaryLabel : CupertinoColors.systemOrange))),
        ]),
        trailing: _working
            ? CupertinoButton(padding: EdgeInsets.zero, onPressed: _stop, child: const Text('Stop', style: TextStyle(fontWeight: FontWeight.w600)))
            : null,
      ),
      child: SafeArea(
        bottom: false,
        child: Column(children: [
          Expanded(child: _body()),
          _Composer(
            controller: _input,
            focus: _focus,
            pictures: _pictures,
            working: _working,
            onSend: () => _send(),
            onStop: _stop,
            onAttach: _attach,
            onRemovePicture: (i) => setState(() => _pictures.removeAt(i)),
          ),
          SizedBox(height: bottomClearance),
        ]),
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
        itemBuilder: (context, i) {
          final entry = entries[entries.length - 1 - i];
          return switch (entry) {
            HistoryEntry(:final item) => _HistoryBubble(item),
            TurnEntry() => _TurnView(turn: entry, onOption: (o) => _send(text: o), onCardButton: _tapCardButton),
            CardEntry() => _CardView(card: entry, onButton: _tapCardButton),
          };
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
    final bg = fromUser ? resolve(context, CupertinoColors.systemBlue) : resolve(context, CupertinoColors.secondarySystemGroupedBackground);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Column(crossAxisAlignment: fromUser ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
        ConstrainedBox(
          constraints: BoxConstraints(maxWidth: width * (fromUser ? 0.78 : 0.9)),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(20)),
            child: child,
          ),
        ),
        if (caption != null)
          Padding(
            padding: const EdgeInsets.only(top: 2, left: 8, right: 8),
            child: Text(caption!, style: TextStyle(fontSize: 11, color: resolve(context, CupertinoColors.tertiaryLabel))),
          ),
      ]),
    );
  }
}

class _UserText extends StatelessWidget {
  const _UserText(this.text, this.pictures);
  final String text;
  final int pictures;
  @override
  Widget build(BuildContext context) {
    final white = CupertinoColors.white;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      if (pictures > 0)
        Row(mainAxisSize: MainAxisSize.min, children: [
          const Icon(CupertinoIcons.photo, size: 15, color: CupertinoColors.white),
          const SizedBox(width: 5),
          Text(pictures == 1 ? 'Picture' : '$pictures pictures', style: const TextStyle(fontSize: 14, color: CupertinoColors.white)),
        ]),
      if (text.isNotEmpty) Text(text, style: TextStyle(fontSize: 16, height: 1.35, color: white, letterSpacing: -0.2)),
    ]);
  }
}

class _HistoryBubble extends StatelessWidget {
  const _HistoryBubble(this.item);
  final ChatHistoryItem item;
  @override
  Widget build(BuildContext context) {
    if (item.fromUser) return _Bubble(fromUser: true, child: _UserText(_stripContext(item.text), item.pictures));
    return _Bubble(
      fromUser: false,
      caption: item.tools.isEmpty ? null : 'Used ${item.tools.length} tool${item.tools.length == 1 ? '' : 's'}',
      child: MarkdownText(_looksHtml(item.text) ? htmlToMarkdown(item.text) : item.text),
    );
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
      children.add(_Bubble(
        fromUser: true,
        caption: turn.pending ? 'Sending…' : (turn.fromTelegram ? 'via Telegram' : null),
        child: _UserText(turn.userText, turn.pictures),
      ));
    }
    if (turn.steps.isNotEmpty || (turn.running && !turn.pending)) children.add(_WorkingCard(turn: turn, onCardButton: onCardButton));
    if (turn.notice != null && turn.running) children.add(_Note(turn.notice!));
    final reply = turn.finalText ?? '';
    if (reply.trim().isNotEmpty) {
      children.add(_Bubble(
        fromUser: false,
        caption: turn.tokens == null ? null : '${_compact(turn.tokens!)} tokens',
        child: MarkdownText(_looksHtml(reply) ? htmlToMarkdown(reply) : reply),
      ));
    }
    if (turn.question != null) {
      children.add(_Bubble(fromUser: false, child: MarkdownText(turn.question!)));
      if (turn.options.isNotEmpty) {
        children.add(Padding(
          padding: const EdgeInsets.only(top: 2, bottom: 4),
          child: Wrap(spacing: 6, runSpacing: 6, children: [
            for (final o in turn.options)
              CupertinoButton(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                minimumSize: const Size(0, 36),
                color: resolve(context, CupertinoColors.systemBlue).withValues(alpha: 0.13),
                borderRadius: BorderRadius.circular(18),
                onPressed: () => onOption(o),
                child: Text(o, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: resolve(context, CupertinoColors.systemBlue))),
              ),
          ]),
        ));
      }
    }
    if (turn.error != null) children.add(_Note(turn.error!, warning: true));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
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
        child: Text(text,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13, height: 1.3, color: resolve(context, warning ? CupertinoColors.systemRed : CupertinoColors.secondaryLabel))),
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
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          decoration: BoxDecoration(color: resolve(context, CupertinoColors.secondarySystemGroupedBackground), borderRadius: BorderRadius.circular(16)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => setState(() => _open = !open),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                child: Row(children: [
                  if (turn.running) const CupertinoActivityIndicator(radius: 7) else Icon(turn.stopped != null ? CupertinoIcons.stop_circle : CupertinoIcons.checkmark_circle, size: 16, color: secondary),
                  const SizedBox(width: 8),
                  Expanded(child: Text(summary, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: secondary))),
                  Icon(open ? CupertinoIcons.chevron_up : CupertinoIcons.chevron_down, size: 13, color: secondary),
                ]),
              ),
            ),
            if (open)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  for (final s in turn.steps)
                    if (s.kind == 'tool')
                      _ToolRow(step: s)
                    else if (s.kind == 'thinking')
                      _ThinkingRow(step: s)
                    else if (s.kind == 'text')
                      Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: MarkdownText(s.text, fontSize: 14.5, color: secondary)),
                ]),
              ),
          ]),
        ),
        // Messages Dave sent during the turn (tables, cards) stay visible even when folded.
        for (final c in cards) _CardView(card: c.card!, onButton: widget.onCardButton),
      ]),
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
        : Icon(s.isError ? CupertinoIcons.xmark_circle_fill : CupertinoIcons.checkmark_circle_fill,
            size: 15, color: resolve(context, s.isError ? CupertinoColors.systemRed : CupertinoColors.systemGreen));
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() => _open = !_open),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(children: [
            SizedBox(width: 18, child: Center(child: icon)),
            const SizedBox(width: 8),
            Expanded(
              child: Text.rich(TextSpan(children: [
                TextSpan(text: _sentence(s.label), style: TextStyle(fontSize: 14.5, color: resolve(context, CupertinoColors.label))),
                if (s.agent != null) TextSpan(text: '  ${s.agent}', style: TextStyle(fontSize: 12, color: secondary)),
              ])),
            ),
            if (s.ms != null) Text(_duration(s.ms!), style: TextStyle(fontSize: 12, color: secondary, fontFeatures: const [FontFeature.tabularFigures()])),
          ]),
        ),
      ),
      if (_open)
        Padding(
          padding: const EdgeInsets.only(left: 26, bottom: 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(s.name, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: secondary)),
            if (s.args != null && s.args is Map && (s.args as Map).isNotEmpty) ...[const SizedBox(height: 4), CodeBox(_pretty(s.args))],
            if (s.result != null) ...[const SizedBox(height: 4), CodeBox(_pretty(s.result))],
          ]),
        ),
    ]);
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
        child: Text(step.text, style: TextStyle(fontSize: 13.5, height: 1.4, fontStyle: FontStyle.italic, color: secondary)),
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
        decoration: BoxDecoration(
          color: resolve(context, CupertinoColors.secondarySystemGroupedBackground),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: resolve(context, CupertinoColors.separator), width: 0.5),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (label != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(children: [
                Icon(icon, size: 13, color: secondary),
                const SizedBox(width: 5),
                Text(label.toUpperCase(), style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, letterSpacing: 0.4, color: secondary)),
                const Spacer(),
                Text(formatAgo(e.at), style: TextStyle(fontSize: 11.5, color: resolve(context, CupertinoColors.tertiaryLabel))),
              ]),
            ),
          body,
          if (buttons.isNotEmpty) CardButtons(rows: buttons, used: card.used, onTap: (b) => onButton(card, b)),
          if (card.result != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(card.result!, style: TextStyle(fontSize: 13, color: secondary))),
        ]),
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
  });
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
    final blue = resolve(context, CupertinoColors.systemBlue);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.s3, Space.s1, Space.s3, 0),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        if (pictures.isNotEmpty)
          SizedBox(
            height: 64,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: pictures.length,
              separatorBuilder: (_, _) => const SizedBox(width: 6),
              itemBuilder: (context, i) => Stack(children: [
                ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.memory(Uint8List.fromList(pictures[i].bytes), width: 58, height: 58, fit: BoxFit.cover)),
                Positioned(
                  right: 0,
                  top: 0,
                  child: GestureDetector(
                    onTap: () => onRemovePicture(i),
                    child: const Icon(CupertinoIcons.xmark_circle_fill, size: 20, color: CupertinoColors.white),
                  ),
                ),
              ]),
            ),
          ),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          CupertinoButton(
            padding: const EdgeInsets.only(right: 6, bottom: 6),
            minimumSize: const Size(36, 36),
            onPressed: onAttach,
            child: Icon(CupertinoIcons.camera, size: 24, color: blue),
          ),
          Expanded(
            child: CupertinoTextField(
              controller: controller,
              focusNode: focus,
              placeholder: 'Message Dave',
              minLines: 1,
              maxLines: 6,
              textCapitalization: TextCapitalization.sentences,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
              decoration: BoxDecoration(
                color: resolve(context, CupertinoColors.secondarySystemGroupedBackground),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: resolve(context, CupertinoColors.separator), width: 0.5),
              ),
            ),
          ),
          const SizedBox(width: 6),
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: controller,
            builder: (context, value, _) {
              final canSend = value.text.trim().isNotEmpty || pictures.isNotEmpty;
              if (working && !canSend) {
                return _RoundButton(icon: CupertinoIcons.stop_fill, color: resolve(context, CupertinoColors.systemRed), semantic: 'Stop', onTap: onStop);
              }
              return _RoundButton(icon: CupertinoIcons.arrow_up, color: canSend ? blue : resolve(context, CupertinoColors.systemGrey3), semantic: 'Send', onTap: canSend ? onSend : null);
            },
          ),
        ]),
      ]),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({required this.icon, required this.color, required this.semantic, this.onTap});
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
            width: 36,
            height: 36,
            margin: const EdgeInsets.only(bottom: 2),
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            child: Icon(icon, size: 18, color: CupertinoColors.white),
          ),
        ),
      );
}
