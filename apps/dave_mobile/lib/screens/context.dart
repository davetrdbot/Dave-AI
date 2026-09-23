import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Dave's context window: how full the last request was and what filled it, plus every AI call he
/// made over the day.
///
/// The total on the window card is the provider's own prompt-token count for that request; the
/// split between parts is measured on the text that was actually sent and scaled to it. When a
/// provider reports no usage at all, the card says the number is an estimate.
class ContextScreen extends StatefulWidget {
  const ContextScreen({super.key});

  @override
  State<ContextScreen> createState() => _ContextScreenState();
}

class _ContextScreenState extends State<ContextScreen> {
  String _source = 'chat';
  int? _hour;

  @override
  Widget build(BuildContext context) => LoadedPage<ContextUsage>(
        title: 'Context',
        load: (api) => api.context(),
        autoRefresh: const Duration(seconds: 30),
        builder: (context, u, reload) {
          final snap = _source == 'chat' ? u.chat : u.autonomous;
          final now = DateTime.now();
          final today = u.hoursOf(now);
          return [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, 0),
                child: CupertinoSlidingSegmentedControl<String>(
                  groupValue: _source,
                  children: const {'chat': Text('Chat'), 'autonomous': Text('Auto-trading')},
                  onValueChanged: (v) => setState(() => _source = v ?? 'chat'),
                ),
              ),
            ),
            SliverToBoxAdapter(child: WindowCard(snapshot: snap, usage: u, source: _source)),
            SliverToBoxAdapter(
              child: _TodayCard(
                hours: today,
                window: snap?.contextWindow ?? u.contextWindow,
                selected: _hour,
                onSelect: (h) {
                  HapticFeedback.selectionClick();
                  setState(() => _hour = _hour == h ? null : h);
                },
              ),
            ),
            SliverToBoxAdapter(child: _Sources(totals: UsageTotals(today))),
            SliverToBoxAdapter(child: _Days(days: u.daily(now, 7))),
          ];
        },
      );
}

/// 8.6K, 164K, 1.0M -- the compact form the panel uses.
String formatTokens(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(n >= 10000000 ? 0 : 1)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(n >= 100000 ? 0 : 1)}K';
  return '$n';
}

String _pct(double v) => v >= 0.001 || v == 0 ? '${(v * 100).toStringAsFixed(1)}%' : '<0.1%';

/// Validated categorical palette (six slots, fixed order, light and dark stepped separately; passed
/// the colour-vision check). Every part is also labelled with its name and share, so colour never
/// carries the meaning alone.
const _partColors = {
  'tools': CupertinoDynamicColor.withBrightness(color: Color(0xFF2A78D6), darkColor: Color(0xFF3987E5)),
  'messages': CupertinoDynamicColor.withBrightness(color: Color(0xFFEB6834), darkColor: Color(0xFFD95926)),
  'systemPrompt': CupertinoDynamicColor.withBrightness(color: Color(0xFF1BAF7A), darkColor: Color(0xFF199E70)),
  'skills': CupertinoDynamicColor.withBrightness(color: Color(0xFFEDA100), darkColor: Color(0xFFC98500)),
  'memory': CupertinoDynamicColor.withBrightness(color: Color(0xFFE87BA4), darkColor: Color(0xFFD55181)),
  'liveContext': CupertinoDynamicColor.withBrightness(color: Color(0xFF4A3AA7), darkColor: Color(0xFF9085E9)),
};

const _usageBlue = CupertinoDynamicColor.withBrightness(color: Color(0xFF2A78D6), darkColor: Color(0xFF3987E5));

/// The panel from the trader's screenshot: used / max, a bar, and what each part takes.
class WindowCard extends StatelessWidget {
  const WindowCard({super.key, required this.snapshot, required this.usage, required this.source});
  final ContextSnapshot? snapshot;
  final ContextUsage usage;
  final String source;

  @override
  Widget build(BuildContext context) {
    final s = snapshot;
    final window = s?.contextWindow ?? usage.contextWindow;
    final mono = TextStyle(fontFamily: 'monospace', fontSize: 13, color: resolve(context, CupertinoColors.secondaryLabel));
    final header = Row(children: [
      const Expanded(child: Text('Context window', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600))),
      if (s != null)
        Flexible(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerRight,
            child: Text(
              window == null ? '${formatTokens(s.promptTokens)} used' : '${formatTokens(s.promptTokens)}/${formatTokens(window)} (${_pct(s.fill ?? 0)})',
              style: mono,
            ),
          ),
        ),
    ]);
    if (s == null) {
      return ContentCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          header,
          const SizedBox(height: Space.s3),
          Text(
            source == 'chat' ? 'No chat request recorded yet. Send Dave a message and this fills in.' : 'No auto-trading cycle recorded yet. It fills in after the next cycle.',
            style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel)),
          ),
          if (usage.model != null) ...[
            const SizedBox(height: Space.s2),
            Text('${usage.providerName} · ${usage.model}${usage.contextWindow == null ? '' : ' · ${formatTokens(usage.contextWindow!)} window'}', style: mono),
          ],
        ]),
      );
    }
    final total = s.promptTokens == 0 ? 1 : s.promptTokens;
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        header,
        const SizedBox(height: Space.s3),
        Semantics(
          label: window == null ? 'Context used: ${formatTokens(s.promptTokens)} tokens' : 'Context ${_pct(s.fill ?? 0)} full',
          child: _FillBar(parts: s.parts, fill: s.fill),
        ),
        const SizedBox(height: Space.s3),
        for (final p in contextParts)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(children: [
              Container(width: 8, height: 8, decoration: BoxDecoration(color: resolve(context, _partColors[p]!), shape: BoxShape.circle)),
              const SizedBox(width: Space.s3),
              Expanded(child: Text(contextPartLabels[p]!, style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel)))),
              Text(formatTokens(s.parts[p] ?? 0), style: mono),
              SizedBox(width: 64, child: Text(_pct((s.parts[p] ?? 0) / total), textAlign: TextAlign.right, style: mono.copyWith(color: resolve(context, CupertinoColors.label)))),
            ]),
          ),
        const SizedBox(height: Space.s3),
        Text(
          [
            if (s.model != null) s.model!,
            formatAgo(s.at),
            '${s.toolCount} tools',
            '${s.messageCount} messages',
            if (s.cachedTokens != null && s.cachedTokens! > 0) '${formatTokens(s.cachedTokens!)} cached',
          ].join('  ·  '),
          style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.tertiaryLabel)),
        ),
        if (s.estimated)
          Padding(
            padding: const EdgeInsets.only(top: Space.s1),
            child: Text('The provider did not report token counts for this request, so the total is estimated from its length.',
                style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.tertiaryLabel))),
          ),
        if (window == null)
          Padding(
            padding: const EdgeInsets.only(top: Space.s1),
            child: Text('This model\'s maximum is not known, so only the tokens used are shown.', style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.tertiaryLabel))),
          ),
      ]),
    );
  }
}

/// The window as a track; the used part is split into its parts, with a 2px gap between them.
class _FillBar extends StatelessWidget {
  const _FillBar({required this.parts, required this.fill});
  final Map<String, int> parts;
  final double? fill;

  @override
  Widget build(BuildContext context) {
    final total = parts.values.fold(0, (s, v) => s + v);
    return LayoutBuilder(builder: (context, c) {
      // A nearly empty window still shows a visible sliver, the way the screenshot does.
      final usedWidth = fill == null ? c.maxWidth : (c.maxWidth * fill!).clamp(total > 0 ? 6.0 : 0.0, c.maxWidth);
      final shown = [for (final p in contextParts) if ((parts[p] ?? 0) > 0) p];
      return ClipRRect(
        borderRadius: BorderRadius.circular(4),
        child: Container(
          height: 8,
          color: resolve(context, CupertinoColors.tertiarySystemFill),
          child: Row(children: [
            SizedBox(
              width: usedWidth,
              child: Row(children: [
                for (var i = 0; i < shown.length; i++) ...[
                  if (i > 0 && usedWidth > 40) const SizedBox(width: 2),
                  Expanded(flex: ((parts[shown[i]]! / total) * 1000).round().clamp(1, 1000), child: Container(color: resolve(context, _partColors[shown[i]]!))),
                ],
              ]),
            ),
          ]),
        ),
      );
    });
  }
}

/// Today's calls, hour by hour, in the phone's own time zone.
class _TodayCard extends StatelessWidget {
  const _TodayCard({required this.hours, required this.window, required this.selected, required this.onSelect});
  final List<HourUsage> hours;
  final int? window;
  final int? selected;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final t = UsageTotals(hours);
    final h = selected == null ? null : hours[selected!];
    final caption = h == null
        ? (t.calls == 0 ? 'No AI calls yet today.' : 'Tap an hour to see it.')
        : '${_hourLabel(selected!)} to ${_hourLabel((selected! + 1) % 24)}  ·  ${formatTokens(h.tokens)} tokens  ·  ${h.calls} call${h.calls == 1 ? '' : 's'}'
            '${h.peakPromptTokens > 0 ? '  ·  largest ${formatTokens(h.peakPromptTokens)}' : ''}';
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('Today', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        const SizedBox(height: Space.s3),
        Row(children: [
          Expanded(child: StatTile(value: formatTokens(t.tokens), label: 'Tokens')),
          Expanded(child: StatTile(value: '${t.calls}', label: 'AI calls')),
          Expanded(
            child: StatTile(
              value: t.peakPromptTokens == 0 ? '--' : formatTokens(t.peakPromptTokens),
              label: window == null || t.peakPromptTokens == 0 ? 'Largest' : 'Largest (${_pct(t.peakPromptTokens / window!)})',
            ),
          ),
        ]),
        const SizedBox(height: Space.s4),
        HourBars(hours: hours, selected: selected, onSelect: onSelect),
        const SizedBox(height: Space.s2),
        Text(caption, style: TextStyle(fontSize: 13, color: resolve(context, CupertinoColors.secondaryLabel))),
        if (t.calls > 0) ...[
          const SizedBox(height: Space.s1),
          Text(
            '${formatTokens(t.promptTokens)} sent  ·  ${formatTokens(t.completionTokens)} written${t.cachedTokens > 0 ? '  ·  ${formatTokens(t.cachedTokens)} from cache' : ''}'
            '${t.estimatedCalls > 0 ? '  ·  ${t.estimatedCalls} estimated' : ''}',
            style: TextStyle(fontSize: 12, color: resolve(context, CupertinoColors.tertiaryLabel)),
          ),
        ],
      ]),
    );
  }
}

String _hourLabel(int h) => h == 0 ? '12am' : h < 12 ? '${h}am' : h == 12 ? '12pm' : '${h - 12}pm';
String _hourTick(int h) => h == 0 ? '12a' : h < 12 ? '${h}a' : h == 12 ? '12p' : '${h - 12}p';

/// 24 thin bars, one per hour, anchored to the baseline. Each whole column is the tap target.
class HourBars extends StatelessWidget {
  const HourBars({super.key, required this.hours, required this.selected, required this.onSelect});
  final List<HourUsage> hours;
  final int? selected;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final peak = hours.fold(0, (m, h) => h.tokens > m ? h.tokens : m);
    final blue = resolve(context, _usageBlue);
    final faint = resolve(context, CupertinoColors.tertiarySystemFill);
    return SizedBox(
      height: 120,
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        for (var i = 0; i < hours.length; i++)
          Expanded(
            child: Semantics(
              button: true,
              label: '${_hourLabel(i)}: ${formatTokens(hours[i].tokens)} tokens, ${hours[i].calls} calls',
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => onSelect(i),
                child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
                  Expanded(
                    child: Align(
                      alignment: Alignment.bottomCenter,
                      child: FractionallySizedBox(
                        heightFactor: peak == 0 ? 0.02 : (hours[i].tokens / peak).clamp(0.02, 1.0),
                        child: Container(
                          margin: const EdgeInsets.symmetric(horizontal: 1.5),
                          decoration: BoxDecoration(
                            color: hours[i].tokens == 0 ? faint : (selected == null || selected == i ? blue : blue.withValues(alpha: 0.35)),
                            borderRadius: const BorderRadius.vertical(top: Radius.circular(3)),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  SizedBox(
                    height: 14,
                    child: i % 6 == 0
                        ? OverflowBox(maxWidth: 40, child: Text(_hourTick(i), style: TextStyle(fontSize: 10, color: resolve(context, CupertinoColors.tertiaryLabel))))
                        : null,
                  ),
                ]),
              ),
            ),
          ),
      ]),
    );
  }
}

const _sourceLabels = {'chat': 'Chat with you', 'autonomous': 'Auto-trading', 'background': 'Background checks', 'worker': 'Helpers', 'review': 'Daily review'};

class _Sources extends StatelessWidget {
  const _Sources({required this.totals});
  final UsageTotals totals;

  @override
  Widget build(BuildContext context) {
    if (totals.calls == 0) return const SizedBox.shrink();
    final rows = totals.bySource.entries.toList()..sort((a, b) => b.value.tokens.compareTo(a.value.tokens));
    final sum = rows.fold(0, (s, r) => s + r.value.tokens);
    return CupertinoListSection.insetGrouped(
      header: const ListHeader('Where today\'s tokens went'),
      children: [
        for (final r in rows)
          CupertinoListTile(
            title: Text(_sourceLabels[r.key] ?? r.key),
            subtitle: Text('${r.value.calls} call${r.value.calls == 1 ? '' : 's'}'),
            additionalInfo: Text('${formatTokens(r.value.tokens)}  ·  ${_pct(sum == 0 ? 0 : r.value.tokens / sum)}'),
          ),
      ],
    );
  }
}

class _Days extends StatelessWidget {
  const _Days({required this.days});
  final List<({DateTime day, UsageTotals totals})> days;

  @override
  Widget build(BuildContext context) {
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return CupertinoListSection.insetGrouped(
      header: const ListHeader('Last 7 days'),
      footer: const ListFooter('Tokens sent to and written by the AI, per day. Kept for 45 days.'),
      children: [
        for (var i = 0; i < days.length; i++)
          CupertinoListTile(
            title: Text(i == 0 ? 'Today' : i == 1 ? 'Yesterday' : '${names[days[i].day.weekday - 1]} ${days[i].day.day}'),
            subtitle: Text(days[i].totals.calls == 0 ? 'No calls' : '${days[i].totals.calls} call${days[i].totals.calls == 1 ? '' : 's'}'),
            additionalInfo: Text(days[i].totals.calls == 0 ? '--' : formatTokens(days[i].totals.tokens)),
          ),
      ],
    );
  }
}
