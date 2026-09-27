import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/chat.dart';
import '../api/client.dart';
import '../api/models.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../look.dart';

/// The autonomous loop ("mode 2") in real time: what Dave is analysing right now and at which
/// stage, every decision with its reason, Flo's and Journal's verdicts, his thoughts, workers and
/// Nous -- and the switch to start or stop him.
class LiveScreen extends StatefulWidget {
  const LiveScreen({super.key});

  @override
  State<LiveScreen> createState() => _LiveScreenState();
}

enum _Filter { all, decisions, alerts, mt5, agents }

/// Live = the running stream; the others read the dated history from the server.
enum _Period { live, today, week, weeks3, custom }

class _LiveScreenState extends State<LiveScreen> {
  final _events = <ActivityEvent>[];
  ChatApi? _api;
  ActivityStream? _stream;
  final _subs = <StreamSubscription<Object?>>[];
  BotState? _bot;
  bool _live = false;
  String? _error;
  _Filter _filter = _Filter.all;
  _Period _period = _Period.live;
  List<ActivityEvent>? _history;
  int _historyTotal = 0;
  bool _historyLoading = false;
  DateTime? _customFrom;
  Timer? _rebuild;
  Timer? _clock;

  static const _keep = 300;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final api = AppScope.of(context).api;
    if (_api?.base != api.base || _api?.token != api.token) {
      _api = ChatApi.of(api);
      unawaited(_load());
    }
  }

  @override
  void initState() {
    super.initState();
    // "12s ago" and the analysing timer tick on their own.
    _clock = Timer.periodic(const Duration(seconds: 5), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _close();
    _clock?.cancel();
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
    final scope = AppScope.of(context);
    try {
      final bot = await scope.api.bot();
      final latest = (await api.activity(after: 1 << 30, feeds: const ['loop'])).latestEventId;
      final recent = await api.activity(after: math.max(0, latest - _keep), feeds: const ['loop', 'background']);
      if (!mounted) return;
      setState(() {
        _bot = bot;
        _events
          ..clear()
          ..addAll(recent.events);
        _error = null;
      });
      _listen(recent.latestEventId);
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  void _listen(int after) {
    _close();
    final stream = _api!.stream(after: after, feeds: const ['loop', 'background']);
    _stream = stream;
    _subs.add(stream.events.listen((e) {
      if (e.feed == 'chat') return;
      _events.add(e);
      if (_events.length > _keep) _events.removeRange(0, _events.length - _keep);
      if (e.kind == 'cycle_end' && e.data['notable'] == true) HapticFeedback.lightImpact();
      if (_rebuild?.isActive ?? false) return;
      _rebuild = Timer(const Duration(milliseconds: 120), () {
        if (mounted) setState(() {});
      });
    }, onError: (Object err) {
      if (err is UnpairedException && mounted) AppScope.of(context).onUnpaired(err.message);
    }));
    _subs.add(stream.connected.listen((live) {
      if (mounted) setState(() => _live = live);
    }));
    stream.start();
  }

  Future<void> _choosePeriod(_Period p) async {
    DateTime? from;
    final now = DateTime.now();
    switch (p) {
      case _Period.live:
        setState(() {
          _period = p;
          _history = null;
        });
        return;
      case _Period.today:
        from = DateTime(now.year, now.month, now.day);
      case _Period.week:
        from = now.subtract(const Duration(days: 7));
      case _Period.weeks3:
        from = now.subtract(const Duration(days: 21));
      case _Period.custom:
        from = await _pickDate(_customFrom ?? now.subtract(const Duration(days: 3)));
        if (from == null) return;
        _customFrom = from;
    }
    setState(() {
      _period = p;
      _historyLoading = true;
    });
    try {
      final r = await _api!.activityRange(from, now);
      if (!mounted) return;
      setState(() {
        _history = r.events;
        _historyTotal = r.total;
        _historyLoading = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() => _historyLoading = false);
        await showError(context, e);
      }
    }
  }

  Future<DateTime?> _pickDate(DateTime initial) async {
    var picked = initial;
    final ok = await showCupertinoModalPopup<bool>(
      context: context,
      builder: (ctx) => Container(
        height: 320,
        color: resolve(ctx, CupertinoColors.systemBackground),
        child: SafeArea(
          top: false,
          child: Column(children: [
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              CupertinoButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
              const Text('Show from', style: TextStyle(fontWeight: FontWeight.w600)),
              CupertinoButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Show')),
            ]),
            Expanded(
              child: CupertinoDatePicker(
                mode: CupertinoDatePickerMode.date,
                initialDateTime: initial,
                minimumDate: DateTime.now().subtract(const Duration(days: 90)),
                maximumDate: DateTime.now(),
                onDateTimeChanged: (d) => picked = d,
              ),
            ),
          ]),
        ),
      ),
    );
    return ok == true ? DateTime(picked.year, picked.month, picked.day) : null;
  }

  Future<void> _setRunning(bool running) async {
    if (!running) {
      final ok = await confirmDestructive(context,
          title: 'Stop autonomous trading?', message: 'Dave stops looking for new trades. Open positions stay open.', action: 'Stop trading');
      if (!ok || !mounted) return;
    }
    final scope = AppScope.of(context);
    try {
      final bot = await scope.api.updateBot(running: running);
      if (mounted) setState(() => _bot = bot);
      HapticFeedback.mediumImpact();
    } catch (e) {
      if (mounted) await showError(context, e);
    }
  }

  /// What Dave is doing right now, read from the newest loop events.
  _Now _now() {
    for (final e in _events.reversed) {
      if (e.feed != 'loop') continue;
      switch (e.kind) {
        case 'analysis':
          final tfs = e.data['timeframes'] is List ? (e.data['timeframes'] as List).join(' · ') : null;
          return _Now(
            busy: true,
            title: 'Analysing ${e.text('symbol')}',
            detail: e.text('stage') == 'deciding' ? 'Deciding: buy, sell, limit or wait' : 'Reading the charts${tfs == null ? '' : ' · $tfs'}',
            since: e.at,
          );
        case 'thought':
          return _Now(busy: true, title: 'Thinking it through', detail: e.text('text'), since: e.at);
        case 'flo':
          return _Now(busy: true, title: 'Flo is reviewing', detail: '${e.text('symbol')} ${e.text('action')}', since: e.at);
        case 'journal':
          return _Now(busy: true, title: 'Asked Journal', detail: e.text('opinion'), since: e.at);
        case 'cycle_start':
          return _Now(busy: true, title: 'Starting a scan', detail: 'Picking the next pair', since: e.at);
        case 'cycle_end':
          final action = e.text('action');
          final symbol = e.text('symbol');
          return _Now(
            busy: false,
            title: e.data['error'] != null ? 'Last scan failed' : (action == 'NONE' || action.isEmpty ? 'No trade last scan' : '$action $symbol'),
            detail: e.data['error'] != null ? e.text('error') : 'Waiting for the next scan',
            since: e.at,
          );
        case 'cycle_skip':
          return _Now(busy: false, title: 'Scan skipped', detail: e.text('reason'), since: e.at);
      }
    }
    return _Now(busy: false, title: _bot?.running == true ? 'Waiting for the next scan' : 'Autonomous trading is off', detail: null, since: null);
  }

  bool _shown(ActivityEvent e) => switch (_filter) {
        _Filter.all => !const {'tool_start', 'tool_end'}.contains(e.kind),
        _Filter.decisions => const {'decision', 'cycle_end', 'flo', 'journal', 'nous_card', 'trade_closed', 'setup'}.contains(e.kind),
        _Filter.alerts => const {'self_aware', 'alert', 'level_hit', 'setup', 'memory', 'scalp', 'trade_modified'}.contains(e.kind),
        _Filter.mt5 => e.kind == 'ea_request',
        _Filter.agents => e.agent != null,
      };

  @override
  Widget build(BuildContext context) {
    final bottom = 110 + MediaQuery.paddingOf(context).bottom;
    final source = _period == _Period.live ? _events.reversed : (_history ?? const <ActivityEvent>[]);
    final shown = source.where(_shown).take(_period == _Period.live ? 150 : 800).toList();
    final now = _now();
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      child: CustomScrollView(
        physics: const BouncingScrollPhysics(parent: AlwaysScrollableScrollPhysics()),
        slivers: [
          const CupertinoSliverNavigationBar(largeTitle: Text('Live'), heroTag: 'nav:Live'),
          CupertinoSliverRefreshControl(onRefresh: _load),
          SliverToBoxAdapter(child: _NowCard(now: now, live: _live, bot: _bot, onRunning: _setRunning)),
          if (_error != null)
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.all(Space.s4),
                child: Text(_error!, style: TextStyle(color: Look.of(context).down)),
              ),
            ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(Space.s4, Space.s4, Space.s4, Space.s2),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(children: [
                    for (final p in _Period.values) ...[
                      _Chip(
                        text: switch (p) {
                          _Period.live => 'Live',
                          _Period.today => 'Today',
                          _Period.week => '7 days',
                          _Period.weeks3 => '3 weeks',
                          _Period.custom => _period == _Period.custom && _customFrom != null ? 'Since ${_customFrom!.day}/${_customFrom!.month}' : 'Pick dates…',
                        },
                        selected: _period == p,
                        onTap: () => _choosePeriod(p),
                      ),
                      const SizedBox(width: 6),
                    ],
                  ]),
                ),
                const SizedBox(height: 8),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(children: [
                    for (final f in _Filter.values) ...[
                      _Chip(
                        text: switch (f) {
                          _Filter.all => 'Everything',
                          _Filter.decisions => 'Decisions',
                          _Filter.alerts => 'Self-aware & alerts',
                          _Filter.mt5 => 'MT5 data',
                          _Filter.agents => 'Flo · Journal · Workers',
                        },
                        selected: _filter == f,
                        onTap: () => setState(() => _filter = f),
                      ),
                      const SizedBox(width: 6),
                    ],
                  ]),
                ),
                if (_period != _Period.live && !_historyLoading)
                  Padding(
                    padding: const EdgeInsets.only(top: 8, left: 4),
                    child: Text(
                      '${shown.length} shown${_historyTotal > (_history?.length ?? 0) ? ' · newest ${_history?.length} of $_historyTotal' : ''}',
                      style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.secondaryLabel)),
                    ),
                  ),
              ]),
            ),
          ),
          if (_historyLoading)
            const SliverToBoxAdapter(child: Padding(padding: EdgeInsets.only(top: Space.s6), child: CupertinoActivityIndicator()))
          else if (shown.isEmpty)
            const SliverToBoxAdapter(
              child: Padding(
                padding: EdgeInsets.only(top: Space.s6),
                child: EmptyState(icon: CupertinoIcons.waveform_path_ecg, title: 'Nothing here', message: 'When Dave scans the market, every step shows up here as it happens. Older days only start filling in from this update on.'),
              ),
            )
          else
            SliverList.builder(itemCount: shown.length, itemBuilder: (context, i) => _EventRow(e: shown[i])),
          SliverToBoxAdapter(child: SizedBox(height: bottom)),
        ],
      ),
    );
  }
}

class _Now {
  _Now({required this.busy, required this.title, required this.detail, required this.since});
  final bool busy;
  final String title;
  final String? detail;
  final DateTime? since;
}

/// The hero: what Dave is doing this second, with the on/off switch.
class _NowCard extends StatelessWidget {
  const _NowCard({required this.now, required this.live, required this.bot, required this.onRunning});
  final _Now now;
  final bool live;
  final BotState? bot;
  final void Function(bool) onRunning;

  @override
  Widget build(BuildContext context) {
    final running = bot?.running == true;
    final look = Look.of(context);
    final ink = look.heroText;
    return Container(
      margin: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, 0),
      padding: const EdgeInsets.all(Space.s4),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(26),
        gradient: look.hero,
        border: Border.all(color: look.line),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          _Pulse(active: now.busy && running),
          const SizedBox(width: 8),
          Text(
            !live ? 'CONNECTING…' : (running ? (now.busy ? 'WORKING' : 'ON') : 'OFF'),
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 1.2, color: ink.withValues(alpha: 0.8)),
          ),
          const Spacer(),
          if (bot != null)
            Text('every ${bot!.intervalMinutes} min', style: TextStyle(fontSize: 12.5, color: ink.withValues(alpha: 0.7))),
        ]),
        const SizedBox(height: Space.s3),
        Text(now.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 30, fontWeight: FontWeight.w800, letterSpacing: -1, color: ink)),
        if (now.detail != null && now.detail!.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(now.detail!, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14.5, height: 1.35, color: ink.withValues(alpha: 0.85))),
        ],
        if (now.since != null) ...[
          const SizedBox(height: 6),
          Text(formatAgo(now.since!), style: TextStyle(fontSize: 12, color: ink.withValues(alpha: 0.6))),
        ],
        const SizedBox(height: Space.s4),
        GestureDetector(
          onTap: bot == null ? null : () => onRunning(!running),
          child: Container(
            height: 48,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: running ? ink.withValues(alpha: 0.12) : look.accent, borderRadius: BorderRadius.circular(24)),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(running ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill, size: 18, color: running ? ink : look.tabActiveIcon),
              const SizedBox(width: 8),
              Text(running ? 'Stop trading' : 'Start trading',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: running ? ink : look.tabActiveIcon)),
            ]),
          ),
        ),
      ]),
    );
  }
}

class _Pulse extends StatefulWidget {
  const _Pulse({required this.active});
  final bool active;
  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900));

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(_Pulse old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    if (widget.active && !_c.isAnimating) {
      _c.repeat(reverse: true);
    } else if (!widget.active) {
      _c
        ..stop()
        ..value = 1;
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: Tween(begin: 0.3, end: 1.0).animate(_c),
        child: Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(
            color: widget.active ? Look.of(context).accent : Look.of(context).heroText.withValues(alpha: 0.6),
            shape: BoxShape.circle,
            boxShadow: widget.active ? [BoxShadow(color: Look.of(context).accent.withValues(alpha: 0.6), blurRadius: 10)] : null,
          ),
        ),
      );
}

class _Chip extends StatelessWidget {
  const _Chip({required this.text, required this.selected, required this.onTap});
  final String text;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => GestureDetector(
          onTap: onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: selected
                ? BoxDecoration(color: resolve(context, CupertinoColors.label), borderRadius: BorderRadius.circular(18))
                : glassDecoration(context, radius: 18),
            child: Text(text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: selected ? resolve(context, CupertinoColors.systemBackground) : resolve(context, CupertinoColors.label))),
          ),
      );
}

/// One step of the loop, in words.
class _EventRow extends StatelessWidget {
  const _EventRow({required this.e});
  final ActivityEvent e;

  @override
  Widget build(BuildContext context) {
    final green = Look.of(context).up;
    final red = Look.of(context).down;
    final blue = Look.of(context).accent;
    final purple = resolve(context, CupertinoColors.systemPurple);
    final grey = resolve(context, CupertinoColors.secondaryLabel);
    final (IconData icon, Color color, String title, String? body) = switch (e.kind) {
      'analysis' => (CupertinoIcons.graph_square, blue, 'Analysing ${e.text('symbol')}', e.text('stage') == 'deciding' ? 'Deciding' : 'Reading the charts'),
      'decision' => _decision(e, green, red, grey),
      'thought' => (CupertinoIcons.lightbulb, purple, 'Thought', e.text('text')),
      'flo' => (e.data['approved'] == true ? CupertinoIcons.checkmark_shield_fill : CupertinoIcons.xmark_shield_fill, e.data['approved'] == true ? green : red,
          'Flo ${e.data['approved'] == true ? 'approved' : 'declined'} ${e.text('symbol')} ${e.text('action')}', e.text('reason')),
      'journal' => (CupertinoIcons.book_fill, purple, 'Journal on ${e.text('symbol')}', e.text('opinion')),
      'cycle_start' => (CupertinoIcons.arrow_2_circlepath, grey, 'Scan started', null),
      'cycle_skip' => (CupertinoIcons.pause_circle, grey, 'Scan skipped', e.text('reason')),
      'cycle_end' => e.data['error'] != null
          ? (CupertinoIcons.exclamationmark_triangle_fill, red, 'Scan failed', e.text('error'))
          : (CupertinoIcons.flag_fill, e.text('action') == 'NONE' ? grey : green, e.text('action') == 'NONE' ? 'Scan done · no trade' : 'Scan done · ${e.text('action')} ${e.text('symbol')}',
              e.text('message').isEmpty ? null : e.text('message')),
      'nous_card' => (CupertinoIcons.antenna_radiowaves_left_right, blue, 'Nous signal', _blocksText(e)),
      'nous_note' => (CupertinoIcons.antenna_radiowaves_left_right, grey, 'Nous', e.text('text')),
      'worker_start' => (CupertinoIcons.person_2_fill, purple, '${e.text('name')} started', e.text('task')),
      'worker_report' || 'worker_done' => (CupertinoIcons.person_2_fill, purple, e.text('name'), e.text('text')),
      'tool_start' || 'tool_end' => (CupertinoIcons.wrench_fill, grey, '${e.agent ?? ''}: ${e.text('label')}${e.kind == 'tool_end' ? ' ✓' : '…'}', null),
      'alert' => (CupertinoIcons.bell_fill, red, 'Alert', e.text('text')),
      'scalp' => (CupertinoIcons.arrow_2_squarepath, green, 'Scalp', e.text('text')),
      'trade_closed' => (CupertinoIcons.chart_bar_alt_fill, (e.data['pnl'] as num? ?? 0) >= 0 ? green : red, 'Trade closed', e.text('text')),
      'trade_modified' => (CupertinoIcons.slider_horizontal_3, grey, 'Trade changed', e.text('text')),
      'self_aware' => (CupertinoIcons.eye_fill, purple, 'Self-aware', e.text('text')),
      'level_hit' => (CupertinoIcons.scope, blue, 'Marked level hit', e.text('text')),
      'setup' => (CupertinoIcons.square_stack_3d_down_right_fill, blue, 'Setup', e.text('text')),
      'memory' => (CupertinoIcons.memories, purple, 'Memory', e.text('text')),
      'ea_request' => (
          e.data['ok'] == false ? CupertinoIcons.exclamationmark_circle : CupertinoIcons.arrow_down_doc,
          e.data['ok'] == false ? red : grey,
          'MT5 · ${_endpointName(e.text('endpoint'))} ${e.text('symbol')} ${e.text('timeframe')}',
          e.data['ok'] == false ? 'Failed after ${_secs(e.data['ms'])}: ${e.text('error')}' : 'Received in ${_secs(e.data['ms'])}',
        ),
      'log' => (CupertinoIcons.text_alignleft, grey, _logTitle(e.text('text')), e.text('text')),
      _ => (CupertinoIcons.circle, grey, e.kind.replaceAll('_', ' '), e.text('text').isEmpty ? null : e.text('text')),
    };
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _showDetail(context, icon, color, title, body),
      child: Container(
      margin: const EdgeInsets.fromLTRB(Space.s4, 4, Space.s4, 4),
      padding: const EdgeInsets.all(Space.s3),
      decoration: glassDecoration(context, radius: 18),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(color: color.withValues(alpha: 0.16), shape: BoxShape.circle),
          child: Icon(icon, size: 18, color: color),
        ),
        const SizedBox(width: Space.s3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
              Text(_clock(e.at), style: TextStyle(fontSize: 12, color: grey, fontFeatures: const [FontFeature.tabularFigures()])),
            ]),
            if (body != null && body.trim().isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(body.trim(), maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, height: 1.35, color: grey)),
              ),
          ]),
        ),
      ]),
      ),
    );
  }

  /// The whole thing -- full reason, every detail -- in a sheet you can scroll and copy from.
  void _showDetail(BuildContext context, IconData icon, Color color, String title, String? body) {
    HapticFeedback.selectionClick();
    final extras = <String, String>{
      for (final entry in e.data.entries)
        if (entry.value is String || entry.value is num || entry.value is bool)
          if (!const {'text', 'reason', 'message', 'opinion'}.contains(entry.key)) entry.key: '${entry.value}',
    };
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) {
        final look = Look.of(ctx);
        return Container(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.8),
          decoration: BoxDecoration(color: look.card, borderRadius: const BorderRadius.vertical(top: Radius.circular(22))),
          child: SafeArea(
            top: false,
            child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(20, 12, 20, 24), children: [
              Center(child: Container(width: 36, height: 4, decoration: BoxDecoration(color: look.line, borderRadius: BorderRadius.circular(2)))),
              const SizedBox(height: 14),
              Row(children: [
                Icon(icon, color: color, size: 22),
                const SizedBox(width: 10),
                Expanded(child: Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700))),
              ]),
              const SizedBox(height: 4),
              Text(
                '${e.at.day}/${e.at.month}/${e.at.year} · ${_clock(e.at)}${e.agent != null ? ' · ${e.agent}' : ''}',
                style: TextStyle(fontSize: 12.5, color: resolve(ctx, CupertinoColors.secondaryLabel)),
              ),
              if (body != null && body.trim().isNotEmpty) ...[
                const SizedBox(height: 14),
                Text(body.trim(), style: TextStyle(fontSize: 15, height: 1.45, color: resolve(ctx, CupertinoColors.label))),
              ],
              if (extras.isNotEmpty) ...[
                const SizedBox(height: 16),
                for (final x in extras.entries)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      SizedBox(width: 110, child: Text(x.key, style: TextStyle(fontSize: 13, color: resolve(ctx, CupertinoColors.secondaryLabel)))),
                      Expanded(child: Text(x.value, style: const TextStyle(fontSize: 13))),
                    ]),
                  ),
              ],
              const SizedBox(height: 8),
              CupertinoButton(
                padding: EdgeInsets.zero,
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: [title, if (body != null) body.trim()].join('\n\n')));
                  Navigator.pop(ctx);
                },
                child: const Text('Copy'),
              ),
            ]),
          ),
        );
      },
    );
  }

  static String _endpointName(String ep) => switch (ep) {
        'all' || 'get_all_analysis' => 'full analysis',
        'candles' => 'candles',
        '' => 'data',
        _ => ep.replaceAll('_', ' '),
      };

  static String _secs(Object? ms) => ms is num ? (ms < 1000 ? '${ms.round()}ms' : '${(ms / 1000).toStringAsFixed(1)}s') : '?';

  /// The first few words of a loop log line, as its title.
  static String _logTitle(String t) {
    final first = t.split(RegExp(r' -- |: ')).first.trim();
    return first.length > 60 ? '${first.substring(0, 60)}…' : first;
  }

  static (IconData, Color, String, String?) _decision(ActivityEvent e, Color green, Color red, Color grey) {
    final action = e.text('action');
    final buy = action.startsWith('BUY');
    final sell = action.startsWith('SELL');
    return (
      buy ? CupertinoIcons.arrow_up_right : (sell ? CupertinoIcons.arrow_down_right : CupertinoIcons.minus_circle),
      buy ? green : (sell ? red : grey),
      '${action.replaceAll('_', ' ')} ${e.text('symbol')}',
      e.text('reason'),
    );
  }

  static String? _blocksText(ActivityEvent e) {
    final blocks = e.data['blocks'];
    if (blocks is! List) return null;
    for (final b in blocks) {
      if (b is Map && b['type'] == 'heading') return '${b['text']}';
    }
    return null;
  }

  static String _clock(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}
