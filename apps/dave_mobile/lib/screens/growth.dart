import 'dart:math' as math;

import 'package:flutter/cupertino.dart';

import '../app_scope.dart';
import '../look.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Dave getting better on his own -- the loop from the trader's pictures, made visible:
///
///   Outcome -> Hypothesis -> Test (change ONE variable) -> Revise (keep or undo)
///
/// Top to bottom: the score against the trader's goal, the strategy card under test (v03 ...),
/// the loop with the current step lit, what success and failure mean (editable), the brain's
/// neurons (tap one to read what it knows), and every earlier version with its verdict.
class GrowthScreen extends StatelessWidget {
  const GrowthScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoadedPage<Map<String, dynamic>>(
      title: 'Growth',
      load: (api) => api.growth(),
      autoRefresh: const Duration(seconds: 30),
      builder: (context, g, reload) {
        Future<void> act(Map<String, Object?> body, {String? done}) async {
          try {
            await AppScope.of(context).api.growthAction(body);
            if (done != null && context.mounted) await _toast(context, done);
          } catch (e) {
            if (context.mounted) await showError(context, e);
          }
          await reload();
        }

        return [
          SliverToBoxAdapter(child: _ScoreCard(g: g)),
          SliverToBoxAdapter(child: _StrategyCard(g: g, act: act)),
          SliverToBoxAdapter(child: _LoopCard(g: g)),
          SliverToBoxAdapter(child: _GoalCard(g: g, act: act, reload: reload)),
          SliverToBoxAdapter(child: _NeuronCard(g: g, act: act, reload: reload)),
          SliverToBoxAdapter(child: _RulesCard(g: g)),
          SliverToBoxAdapter(child: _VersionsCard(g: g)),
          const SliverToBoxAdapter(child: SizedBox(height: 110)),
        ];
      },
    );
  }
}

Future<void> _toast(BuildContext context, String text) => showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        content: Text(text),
        actions: [CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );

String _signed(num v) => '${v >= 0 ? '+' : ''}${v.toStringAsFixed(2)}';
String _vName(Object? v) => 'v${(v as num? ?? 0).toInt().toString().padLeft(2, '0')}';

Map<String, dynamic> _m(Object? o) => (o as Map?)?.cast<String, dynamic>() ?? const {};
List<Map<String, dynamic>> _l(Object? o) => ((o as List?) ?? const []).map((e) => _m(e)).toList();

Color _verdictColor(BuildContext context, String verdict) {
  final look = Look.of(context);
  switch (verdict) {
    case 'success':
      return look.up;
    case 'failure':
      return look.down;
    case 'off_track':
      return resolve(context, CupertinoColors.systemOrange);
    default:
      return look.accent;
  }
}

String _verdictText(String verdict) => switch (verdict) {
      'success' => 'Meeting the goal',
      'on_track' => 'On track',
      'off_track' => 'Off track',
      'failure' => 'Failure limit hit',
      _ => 'No closed trades yet',
    };

// ───────────────────────────── score ─────────────────────────────

class _ScoreCard extends StatelessWidget {
  const _ScoreCard({required this.g});
  final Map<String, dynamic> g;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final status = _m(g['status']);
    final score = _m(status['score']);
    final verdict = '${score['verdict'] ?? 'no_data'}';
    final value = (score['score'] as num? ?? 0).toDouble();
    final color = _verdictColor(context, verdict);
    final m = _m(score['metrics']);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    String pct(Object? v, [int d = 0]) => v == null ? '—' : '${(v as num).toStringAsFixed(d)}%';
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: SectionLabel('Score vs goal')),
          _Pill(text: _verdictText(verdict), color: color),
        ]),
        const SizedBox(height: Space.s3),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(verdict == 'no_data' ? '—' : _signed(value), style: TextStyle(fontSize: 44, fontWeight: FontWeight.w800, letterSpacing: -1.5, color: color, fontFeatures: const [FontFeature.tabularFigures()])),
          const SizedBox(width: Space.s3),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text('−1 far from it · 0 halfway · +1 at or past it', style: TextStyle(fontSize: 12, color: secondary)),
            ),
          ),
        ]),
        const SizedBox(height: Space.s2),
        _Gauge(value: value, color: color),
        const SizedBox(height: Space.s4),
        Wrap(spacing: Space.s2, runSpacing: Space.s2, children: [
          _Metric(label: 'Trades', value: '${m['trades'] ?? 0}'),
          _Metric(label: 'Win rate', value: pct(m['winRatePct'])),
          _Metric(label: 'Profit factor', value: m['profitFactor'] == null ? '—' : (m['profitFactor'] as num).clamp(0, 99).toStringAsFixed(2)),
          _Metric(label: 'Month pace', value: pct(m['monthlyReturnPct'], 1)),
          _Metric(label: 'Drawdown', value: pct(m['maxDrawdownPct'], 1)),
          _Metric(label: 'Worst streak', value: '${m['longestLosingStreak'] ?? 0}'),
        ]),
        if (look.dark) const SizedBox(height: 2),
      ]),
    );
  }
}

class _Gauge extends StatelessWidget {
  const _Gauge({required this.value, required this.color});
  final double value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final track = resolve(context, CupertinoColors.systemGrey5);
    return LayoutBuilder(builder: (context, c) {
      final w = c.maxWidth;
      final x = ((value.clamp(-1.0, 1.0) + 1) / 2) * w;
      return SizedBox(
        height: 14,
        child: Stack(clipBehavior: Clip.none, children: [
          Positioned(top: 4, left: 0, right: 0, child: Container(height: 6, decoration: BoxDecoration(color: track, borderRadius: BorderRadius.circular(3)))),
          Positioned(top: 4, left: math.min(w / 2, x), width: (x - w / 2).abs(), child: Container(height: 6, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3)))),
          Positioned(top: 0, left: w / 2 - 1, child: Container(width: 2, height: 14, color: resolve(context, CupertinoColors.systemGrey2))),
          Positioned(top: 1, left: (x - 6).clamp(0, w - 12), child: Container(width: 12, height: 12, decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: resolve(context, CupertinoColors.systemBackground), width: 2)))),
        ]),
      );
    });
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(10)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: TextStyle(fontSize: 11, color: resolve(context, CupertinoColors.secondaryLabel))),
        Text(value, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()])),
      ]),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text, required this.color});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(20)),
        child: Text(text, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: color)),
      );
}

// ───────────────────────────── strategy card ─────────────────────────────

class _StrategyCard extends StatelessWidget {
  const _StrategyCard({required this.g, required this.act});
  final Map<String, dynamic> g;
  final Future<void> Function(Map<String, Object?>, {String? done}) act;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final cur = _m(g['current']);
    final settings = _m(cur['settings']);
    final status = _m(g['status']);
    final testing = cur['status'] == 'testing';
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final testScore = _m(status['testScore']);
    final rows = <(String, String)>[
      ('Change', '${cur['changeText'] ?? 'none -- your own settings'}'),
      ('Min R:R', '${settings['minRiskReward'] ?? '—'}'),
      ('Confidence bar', '${settings['minConfidence'] ?? '—'}%'),
      ('Rules', '${_l(g['rules']).length}'),
      if (cur['baselineScore'] != null) ('Score to beat', _signed(cur['baselineScore'] as num)),
      if (testing && testScore['verdict'] != null && testScore['verdict'] != 'no_data') ('Score so far', _signed(testScore['score'] as num)),
      ('Cycle', '${g['cycle'] ?? 1} · ${status['tradesInCycle'] ?? 0}/${status['tradesPerCycle'] ?? 0} trades'),
    ];
    return Container(
      margin: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, Space.s2),
      padding: const EdgeInsets.all(Space.s4),
      decoration: BoxDecoration(gradient: look.hero, borderRadius: BorderRadius.circular(22)),
      child: DefaultTextStyle.merge(
        style: TextStyle(color: look.heroText),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text('STRATEGY', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 1.4, color: look.heroText.withValues(alpha: 0.7))),
            const Spacer(),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
              decoration: BoxDecoration(color: look.heroText.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(20)),
              child: Text(testing ? 'TESTING' : '${cur['status']}'.toUpperCase(), style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: look.heroText)),
            ),
          ]),
          Text(_vName(cur['v']), style: TextStyle(fontSize: 40, fontWeight: FontWeight.w900, letterSpacing: -1, color: look.heroText)),
          const SizedBox(height: Space.s2),
          for (final r in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(width: 120, child: Text(r.$1, style: TextStyle(fontSize: 13, color: look.heroText.withValues(alpha: 0.7)))),
                Expanded(child: Text(r.$2, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
              ]),
            ),
          if (cur['hypothesis'] != null && '${cur['hypothesis']}'.isNotEmpty) ...[
            const SizedBox(height: Space.s2),
            Text('💡 ${cur['hypothesis']}', style: TextStyle(fontSize: 13, height: 1.35, color: look.heroText.withValues(alpha: 0.92))),
          ],
          const SizedBox(height: Space.s3),
          Row(children: [
            Expanded(
              child: _HeroButton(
                icon: CupertinoIcons.sparkles,
                label: 'Reflect now',
                onTap: () => act({'action': 'reflect'}, done: "Dave will reflect within a minute. The result shows up here and in Live."),
              ),
            ),
            if (testing) ...[
              const SizedBox(width: Space.s2),
              Expanded(
                child: _HeroButton(
                  icon: CupertinoIcons.stop_circle,
                  label: 'Stop test',
                  onTap: () async {
                    final ok = await confirmDestructive(context, title: 'Stop this test?', message: 'The change (${cur['changeText']}) is undone and the previous version stands.', action: 'Stop and undo');
                    if (ok) await act({'action': 'stop_test'});
                  },
                ),
              ),
            ],
          ]),
          if (!(_m(g['goals'])['enabled'] as bool? ?? true))
            Padding(
              padding: const EdgeInsets.only(top: Space.s2),
              child: Text('Self-improvement is switched off -- turn it on under Goal.', style: TextStyle(fontSize: 12, color: secondary)),
            ),
        ]),
      ),
    );
  }
}

class _HeroButton extends StatelessWidget {
  const _HeroButton({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 11),
        decoration: BoxDecoration(color: look.heroText.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(14)),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(icon, size: 17, color: look.heroText),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(fontWeight: FontWeight.w700, color: look.heroText)),
        ]),
      ),
    );
  }
}

// ───────────────────────────── the loop ─────────────────────────────

class _LoopCard extends StatelessWidget {
  const _LoopCard({required this.g});
  final Map<String, dynamic> g;

  static const _steps = [
    ('outcome', 'Outcome', 'looks at the result', CupertinoIcons.chart_bar_alt_fill),
    ('hypothesis', 'Hypothesis', 'writes why', CupertinoIcons.lightbulb_fill),
    ('test', 'Test', 'changes one variable', CupertinoIcons.lab_flask_solid),
    ('revise', 'Revise', 'keeps it or undoes it', CupertinoIcons.arrow_2_circlepath),
  ];

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final stage = '${_m(g['status'])['stage'] ?? 'outcome'}';
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SectionLabel('The loop -- one variable at a time'),
        const SizedBox(height: Space.s3),
        Row(children: [
          for (var i = 0; i < _steps.length; i++) ...[
            Expanded(
              child: Column(children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: _steps[i].$1 == stage ? look.accent : look.chip,
                    boxShadow: _steps[i].$1 == stage ? [BoxShadow(color: look.accent.withValues(alpha: 0.45), blurRadius: 14)] : null,
                  ),
                  child: Icon(_steps[i].$4, size: 20, color: _steps[i].$1 == stage ? look.tabActiveIcon : secondary),
                ),
                const SizedBox(height: 6),
                Text(_steps[i].$2, style: TextStyle(fontSize: 12, fontWeight: _steps[i].$1 == stage ? FontWeight.w800 : FontWeight.w600)),
                Text(_steps[i].$3, textAlign: TextAlign.center, style: TextStyle(fontSize: 10, color: secondary)),
              ]),
            ),
            if (i < _steps.length - 1) Padding(padding: const EdgeInsets.only(bottom: 30), child: Icon(CupertinoIcons.chevron_right, size: 12, color: secondary)),
          ],
        ]),
      ]),
    );
  }
}

// ───────────────────────────── goal ─────────────────────────────

class _GoalCard extends StatelessWidget {
  const _GoalCard({required this.g, required this.act, required this.reload});
  final Map<String, dynamic> g;
  final Future<void> Function(Map<String, Object?>, {String? done}) act;
  final Future<void> Function() reload;

  Future<void> _edit(BuildContext context) async {
    final goals = _m(g['goals']);
    const fields = [
      ('targetMonthlyReturnPct', 'Success: monthly return %'),
      ('minWinRatePct', 'Success: minimum win rate %'),
      ('minProfitFactor', 'Success: minimum profit factor'),
      ('maxDrawdownPct', 'Failure: drawdown deeper than %'),
      ('maxLosingStreak', 'Failure: losses in a row'),
      ('maxDailyLossPct', 'Failure: one day worse than %'),
      ('tradesPerCycle', 'Trades per test cycle'),
    ];
    final api = AppScope.of(context).api;
    await pushScoped<bool>(
      context,
      EditorPage(
        title: 'Goal',
        fields: [for (final f in fields) EditorField(label: f.$2, initial: '${goals[f.$1] ?? ''}')],
        footer: 'Success = every success number met. Failure = any one failure number crossed -- that counts as failure however good the rest looks. Dave is scored against these after every cycle of trades.',
        onSave: (v) async {
          await api.growthAction({
            'action': 'goals',
            'goals': {for (var i = 0; i < fields.length; i++) fields[i].$1: num.tryParse(v[i].trim()) ?? v[i]},
          });
        },
      ),
    );
    await reload();
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final checks = _l(_m(_m(g['status'])['score'])['checks']);
    final def = _m(g['definition']);
    final goals = _m(g['goals']);
    final enabled = goals['enabled'] as bool? ?? true;
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    Widget row(String text, bool? ok, String? value, bool failure) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            Icon(
              ok == null ? (failure ? CupertinoIcons.xmark_shield : CupertinoIcons.flag) : ok ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.xmark_circle_fill,
              size: 18,
              color: ok == null ? secondary : ok ? look.up : look.down,
            ),
            const SizedBox(width: Space.s2),
            Expanded(child: Text(text, style: const TextStyle(fontSize: 14))),
            if (value != null) Text(value, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: secondary, fontFeatures: const [FontFeature.tabularFigures()])),
          ]),
        );
    final successChecks = checks.where((c) => c['kind'] == 'success').toList();
    final failureChecks = checks.where((c) => c['kind'] == 'failure').toList();
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: SectionLabel('Goal -- what success and failure mean')),
          CupertinoButton(padding: EdgeInsets.zero, minimumSize: const Size(30, 30), onPressed: () => _edit(context), child: const Text('Edit')),
        ]),
        Text('SUCCESS', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1, color: look.up)),
        if (successChecks.isNotEmpty)
          for (final c in successChecks) row('${c['goal']}', c['ok'] as bool?, '${c['value']}', false)
        else
          for (final t in (def['success'] as List? ?? const [])) row('$t', null, null, false),
        const SizedBox(height: Space.s2),
        Text('FAILURE (any one)', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1, color: look.down)),
        if (failureChecks.isNotEmpty)
          for (final c in failureChecks) row('${c['goal']}', c['ok'] as bool?, '${c['value']}', true)
        else
          for (final t in (def['failure'] as List? ?? const [])) row('$t', null, null, true),
        const SizedBox(height: Space.s3),
        Text('Per trade', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: secondary)),
        const SizedBox(height: 2),
        for (final t in (_m(def['perTrade'])['success'] as List? ?? const [])) Text('✓ $t', style: TextStyle(fontSize: 12.5, height: 1.4, color: secondary)),
        for (final t in (_m(def['perTrade'])['failure'] as List? ?? const [])) Text('✗ $t', style: TextStyle(fontSize: 12.5, height: 1.4, color: secondary)),
        const SizedBox(height: Space.s3),
        Row(children: [
          const Expanded(child: Text('Dave improves himself', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
          CupertinoSwitch(value: enabled, activeTrackColor: look.accent, onChanged: (v) => act({'action': 'goals', 'goals': {'enabled': v}})),
        ]),
        Text('He can only tighten your numbers (a higher R:R floor, a higher confidence bar), add rules or leave a pair alone -- never loosen what you set.', style: TextStyle(fontSize: 12, color: secondary)),
      ]),
    );
  }
}

// ───────────────────────────── neurons ─────────────────────────────

class _NeuronCard extends StatelessWidget {
  const _NeuronCard({required this.g, required this.act, required this.reload});
  final Map<String, dynamic> g;
  final Future<void> Function(Map<String, Object?>, {String? done}) act;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final neurons = _l(g['neurons']);
    final total = neurons.fold<int>(0, (s, n) => s + _l(n['facts']).length);
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: SectionLabel('Brain -- neurons')),
          Text('$total facts', style: TextStyle(fontSize: 13, color: resolve(context, CupertinoColors.secondaryLabel))),
        ]),
        const SizedBox(height: Space.s2),
        _NeuronMap(neurons: neurons, onTap: (n) => _openNeuron(context, n)),
        const SizedBox(height: Space.s2),
        Text('Tap a neuron to see what Dave has learned about it. Brighter = more facts; each fact grows stronger when later trades agree with it and fades when they don\'t.',
            style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.secondaryLabel))),
      ]),
    );
  }

  Future<void> _openNeuron(BuildContext context, Map<String, dynamic> n) async {
    await pushScoped<void>(context, _NeuronPage(neuronId: '${n['id']}'));
    await reload();
  }
}

class _NeuronMap extends StatelessWidget {
  const _NeuronMap({required this.neurons, required this.onTap});
  final List<Map<String, dynamic>> neurons;
  final void Function(Map<String, dynamic>) onTap;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    return LayoutBuilder(builder: (context, c) {
      final w = c.maxWidth;
      final h = math.min(420.0, w * 1.12);
      final center = Offset(w / 2, h / 2);
      final n = neurons.length;
      final maxFacts = neurons.fold<int>(1, (m, x) => math.max(m, _l(x['facts']).length));
      // Outer ring holds most neurons, inner ring the rest, offset by half a step so no two sit on
      // the same spoke. Radii leave room for the biggest node and its label at the edges.
      final outerCount = n <= 8 ? n : (n * 0.6).ceil();
      final innerCount = n - outerCount;
      final rxOuter = w / 2 - 38, ryOuter = h / 2 - 40;
      final rxInner = rxOuter * 0.55, ryInner = ryOuter * 0.55;
      final positions = <Offset>[];
      for (var i = 0; i < n; i++) {
        final outer = i < outerCount;
        final k = outer ? i : i - outerCount;
        final count = outer ? outerCount : innerCount;
        final a = -math.pi / 2 + (k + (outer ? 0 : 0.5)) * 2 * math.pi / math.max(1, count);
        positions.add(center + Offset(math.cos(a) * (outer ? rxOuter : rxInner), math.sin(a) * (outer ? ryOuter : ryInner)));
      }
      return SizedBox(
        width: w,
        height: h,
        child: Stack(children: [
          Positioned.fill(child: CustomPaint(painter: _Wires(center: center, points: positions, neurons: neurons, color: look.accent, line: look.line))),
          Positioned(
            left: center.dx - 30,
            top: center.dy - 30,
            child: Container(
              width: 60,
              height: 60,
              alignment: Alignment.center,
              decoration: BoxDecoration(shape: BoxShape.circle, gradient: look.hero, boxShadow: [BoxShadow(color: look.accent.withValues(alpha: 0.4), blurRadius: 18)]),
              child: Text('Dave', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13, color: look.heroText)),
            ),
          ),
          for (var i = 0; i < n; i++) _node(context, neurons[i], positions[i], maxFacts, look),
        ]),
      );
    });
  }

  Widget _node(BuildContext context, Map<String, dynamic> neuron, Offset p, int maxFacts, Look look) {
    final count = _l(neuron['facts']).length;
    final t = count / maxFacts;
    final size = 34.0 + 12 * t;
    final lit = count > 0;
    return Positioned(
      left: p.dx - size / 2,
      top: p.dy - size / 2 - 7,
      child: GestureDetector(
        key: ValueKey('neuron-${neuron['id']}'),
        onTap: () => onTap(neuron),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: size,
            height: size,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: lit ? look.accent.withValues(alpha: 0.18 + 0.5 * t) : look.chip,
              border: Border.all(color: lit ? look.accent : look.line, width: 1.5),
              boxShadow: lit ? [BoxShadow(color: look.accent.withValues(alpha: 0.35 * t + 0.1), blurRadius: 10 + 10 * t)] : null,
            ),
            child: Text('${neuron['emoji'] ?? '•'}', style: TextStyle(fontSize: 14 + 6 * t)),
          ),
          const SizedBox(height: 2),
          Text(count > 0 ? '${neuron['label']} $count' : '${neuron['label']}', style: TextStyle(fontSize: 10, fontWeight: lit ? FontWeight.w700 : FontWeight.w500, color: lit ? null : resolve(context, CupertinoColors.secondaryLabel))),
        ]),
      ),
    );
  }
}

class _Wires extends CustomPainter {
  _Wires({required this.center, required this.points, required this.neurons, required this.color, required this.line});
  final Offset center;
  final List<Offset> points;
  final List<Map<String, dynamic>> neurons;
  final Color color;
  final Color line;

  @override
  void paint(Canvas canvas, Size size) {
    for (var i = 0; i < points.length; i++) {
      final lit = _l(neurons[i]['facts']).isNotEmpty;
      final paint = Paint()
        ..color = lit ? color.withValues(alpha: 0.55) : line
        ..strokeWidth = lit ? 2 : 1;
      canvas.drawLine(center, points[i], paint);
    }
  }

  @override
  bool shouldRepaint(covariant _Wires old) => old.points != points || old.neurons != neurons || old.color != color;
}

class _NeuronPage extends StatelessWidget {
  const _NeuronPage({required this.neuronId});
  final String neuronId;

  @override
  Widget build(BuildContext context) {
    return LoadedPage<Map<String, dynamic>>(
      title: 'Neuron',
      load: (api) => api.growth(),
      builder: (context, g, reload) {
        final neuron = _l(g['neurons']).firstWhere((n) => n['id'] == neuronId, orElse: () => {'id': neuronId, 'label': neuronId, 'facts': []});
        final facts = _l(neuron['facts'])..sort((a, b) => ((b['strength'] as num?) ?? 0).compareTo((a['strength'] as num?) ?? 0));
        final look = Look.of(context);
        final secondary = resolve(context, CupertinoColors.secondaryLabel);
        final api = AppScope.of(context).api;
        return [
          SliverToBoxAdapter(
            child: ContentCard(
              child: Row(children: [
                Text('${neuron['emoji'] ?? '✨'}', style: const TextStyle(fontSize: 34)),
                const SizedBox(width: Space.s3),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${neuron['label']}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                    Text(facts.isEmpty ? 'Nothing learned yet' : '${facts.length} fact${facts.length == 1 ? '' : 's'}', style: TextStyle(color: secondary)),
                  ]),
                ),
              ]),
            ),
          ),
          if (facts.isEmpty)
            SliverToBoxAdapter(
              child: ContentCard(
                child: Text('Dave fills this neuron when a trade teaches him something specific about ${neuron['label']}. You can also teach him directly below.', style: TextStyle(color: secondary)),
              ),
            ),
          for (final f in facts)
            SliverToBoxAdapter(
              child: ContentCard(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    for (var i = 0; i < 5; i++)
                      Padding(
                        padding: const EdgeInsets.only(right: 3),
                        child: Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: i < ((f['strength'] as num?) ?? 0) ? look.accent : look.chip)),
                      ),
                    const SizedBox(width: 6),
                    Text(_sourceText('${f['source']}'), style: TextStyle(fontSize: 11, color: secondary)),
                    const Spacer(),
                    GestureDetector(
                      onTap: () async {
                        final ok = await confirmDestructive(context, title: 'Forget this?', message: '${f['text']}', action: 'Forget');
                        if (!ok) return;
                        try {
                          await api.growthAction({'action': 'forget', 'id': f['id']});
                        } catch (e) {
                          if (context.mounted) await showError(context, e);
                        }
                        await reload();
                      },
                      child: Icon(CupertinoIcons.trash, size: 17, color: secondary),
                    ),
                  ]),
                  const SizedBox(height: 6),
                  Text('${f['text']}', style: const TextStyle(fontSize: 15, height: 1.35)),
                  if (f['evidence'] != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Evidence: ${f['evidence']}', style: TextStyle(fontSize: 12, color: secondary))),
                  if (((f['confirmations'] as num?) ?? 0) > 0 || ((f['contradictions'] as num?) ?? 0) > 0)
                    Padding(padding: const EdgeInsets.only(top: 4), child: Text('Confirmed ${f['confirmations']}× · contradicted ${f['contradictions']}×', style: TextStyle(fontSize: 12, color: secondary))),
                ]),
              ),
            ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.all(Space.s4),
              child: CupertinoButton.filled(
                onPressed: () async {
                  final text = await promptText(context, title: 'Teach Dave', message: 'One specific thing about ${neuron['label']} -- pair, timeframe, what happens.', placeholder: 'e.g. Boom 1000 spikes after 20+ quiet M1 candles', action: 'Teach');
                  if (text == null || text.isEmpty) return;
                  try {
                    await api.growthAction({'action': 'learn', 'neuron': neuronId, 'text': text});
                  } catch (e) {
                    if (context.mounted) await showError(context, e);
                  }
                  await reload();
                },
                child: const Text('Teach Dave something'),
              ),
            ),
          ),
        ];
      },
    );
  }

  static String _sourceText(String s) => switch (s) {
        'reflection' => 'from a reflection',
        'trader' => 'you taught this',
        _ => 'Dave noted this',
      };
}

// ───────────────────────────── rules + versions ─────────────────────────────

class _RulesCard extends StatelessWidget {
  const _RulesCard({required this.g});
  final Map<String, dynamic> g;

  @override
  Widget build(BuildContext context) {
    final rules = _l(g['rules']);
    final avoid = _l(g['avoidSymbols']);
    if (rules.isEmpty && avoid.isEmpty) return const SizedBox.shrink();
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SectionLabel("Dave's own rules"),
        const SizedBox(height: Space.s2),
        for (final r in rules)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${_vName(r['addedInV'])}  ', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: secondary)),
              Expanded(child: Text('${r['text']}', style: const TextStyle(fontSize: 14))),
            ]),
          ),
        if (avoid.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Leaving alone: ${avoid.map((a) => a['symbol']).join(', ')}', style: TextStyle(fontSize: 13, color: secondary))),
      ]),
    );
  }
}

class _VersionsCard extends StatelessWidget {
  const _VersionsCard({required this.g});
  final Map<String, dynamic> g;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final versions = _l(g['versions']);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    Color colorFor(String s) => switch (s) {
          'kept' => look.up,
          'reverted' => look.down,
          'testing' => look.accent,
          _ => secondary,
        };
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SectionLabel('Versions'),
        const SizedBox(height: Space.s2),
        for (var i = 0; i < versions.length; i++)
          IntrinsicHeight(
            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              SizedBox(
                width: 22,
                child: Column(children: [
                  Container(width: 12, height: 12, margin: const EdgeInsets.only(top: 4), decoration: BoxDecoration(shape: BoxShape.circle, color: colorFor('${versions[i]['status']}'))),
                  if (i < versions.length - 1) Expanded(child: Container(width: 2, color: look.line)),
                ]),
              ),
              const SizedBox(width: Space.s2),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Space.s3),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Text(_vName(versions[i]['v']), style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                      const SizedBox(width: 8),
                      Text('${versions[i]['status']}', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: colorFor('${versions[i]['status']}'))),
                      const Spacer(),
                      if (versions[i]['score'] != null) Text(_signed(versions[i]['score'] as num), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: secondary)),
                    ]),
                    Text('${versions[i]['changeText'] ?? versions[i]['outcome'] ?? ''}', style: const TextStyle(fontSize: 13.5)),
                    if (versions[i]['hypothesis'] != null) Text('💡 ${versions[i]['hypothesis']}', style: TextStyle(fontSize: 12, color: secondary)),
                    if (versions[i]['verdictNote'] != null) Text('${versions[i]['verdictNote']}', style: TextStyle(fontSize: 12, color: secondary)),
                  ]),
                ),
              ),
            ]),
          ),
      ]),
    );
  }
}
