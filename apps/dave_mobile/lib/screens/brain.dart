import 'package:flutter/cupertino.dart';

import '../api/models.dart';
import '../theme.dart';
import '../widgets/charts.dart';
import '../widgets/common.dart';

/// Everything Dave durably knows, in the two stores it actually keeps.
///
/// The screen keeps them visibly apart because they are genuinely different things:
///   - MEMORY is about the person -- small, hard-capped, read on every single turn. Its fullness
///     matters, so it is shown as a meter.
///   - KNOWLEDGE is about markets and Dave's own trading -- unbounded, and it survives /reset.
///     Each entry has a "use when" trigger, which is how Dave finds it mid-cycle.
///
/// The map at the top draws both; the lists under it are the same data in full, which is also
/// what makes the map accessible (every dot is readable below as text).
class BrainScreen extends StatelessWidget {
  const BrainScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoadedPage<Brain>(
      title: 'Brain',
      load: (api) => api.brain(),
      builder: (context, b, reload) {
        final memorySizes = [...b.userFacts, ...b.notes].map((s) => s.length).toList();
        final knowledgeSizes = b.knowledge.map((k) => k.chars).toList();
        final empty = memorySizes.isEmpty && knowledgeSizes.isEmpty;
        return [
          SliverToBoxAdapter(
            child: ContentCard(
              child: empty
                  ? const EmptyState(
                      icon: CupertinoIcons.lightbulb,
                      title: 'Nothing learned yet',
                      message: 'As Dave talks with you and trades, what it learns about you and about the markets shows up here.',
                    )
                  : BrainMap(memorySizes: memorySizes, knowledgeSizes: knowledgeSizes),
            ),
          ),
          SliverToBoxAdapter(child: _MemoryMeter(b: b)),
          SliverToBoxAdapter(child: _Entries(title: 'About you', icon: CupertinoIcons.person, entries: b.userFacts, empty: 'Nothing saved about you yet.')),
          SliverToBoxAdapter(child: _Entries(title: 'Notes', icon: CupertinoIcons.doc_text, entries: b.notes, empty: 'No notes yet.')),
          SliverToBoxAdapter(child: _Knowledge(items: b.knowledge)),
        ];
      },
    );
  }
}

class _MemoryMeter extends StatelessWidget {
  const _MemoryMeter({required this.b});
  final Brain b;

  @override
  Widget build(BuildContext context) {
    final fraction = (b.usedChars / b.budgetChars).clamp(0.0, 1.0);
    // Past 80% Dave is told to consolidate (live-context.ts) -- orange says the same thing here.
    final tight = b.usagePercent >= 80;
    final bar = resolve(context, tight ? CupertinoColors.systemOrange : CupertinoColors.systemBlue);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: SectionLabel('Memory')),
          Text('${b.usagePercent}% full', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: tight ? bar : secondary)),
        ]),
        const SizedBox(height: Space.s3),
        ClipRRect(
          borderRadius: BorderRadius.circular(3),
          child: Stack(children: [
            Container(height: 6, color: resolve(context, CupertinoColors.systemGrey5)),
            FractionallySizedBox(widthFactor: fraction, child: Container(height: 6, color: bar)),
          ]),
        ),
        const SizedBox(height: Space.s2),
        Text(
          tight
              ? 'Nearly full. Dave consolidates older entries to make room rather than dropping new ones.'
              : 'Memory is small on purpose: it is read on every turn. Lasting lessons go to knowledge instead.',
          style: TextStyle(fontSize: 13, color: secondary),
        ),
      ]),
    );
  }
}

class _Entries extends StatelessWidget {
  const _Entries({required this.title, required this.icon, required this.entries, required this.empty});
  final String title;
  final IconData icon;
  final List<String> entries;
  final String empty;

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(
        header: ListHeader('$title  ${entries.length}'),
        children: entries.isEmpty
            ? [CupertinoListTile(title: Text(empty, style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel))))]
            : [
                for (final e in entries)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: Space.s4, vertical: Space.s3),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Padding(padding: const EdgeInsets.only(top: 2), child: Icon(icon, size: 18, color: resolve(context, ChartColors.memory))),
                      const SizedBox(width: Space.s3),
                      Expanded(child: Text(e, style: const TextStyle(fontSize: 15))),
                    ]),
                  ),
              ],
      );
}

class _Knowledge extends StatelessWidget {
  const _Knowledge({required this.items});
  final List<KnowledgeItem> items;

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(
        header: ListHeader('KNOWLEDGE  ${items.length}'),
        footer: const ListFooter('Lessons about markets and Dave\'s own trading. They survive a reset.'),
        children: items.isEmpty
            ? [CupertinoListTile(title: Text('No lessons saved yet.', style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel))))]
            : [
                for (final k in items)
                  CupertinoListTile(
                    leading: Icon(CupertinoIcons.book, color: resolve(context, ChartColors.knowledge)),
                    title: Text(k.title),
                    subtitle: k.useWhen.isEmpty ? null : Text('Use when: ${k.useWhen}'),
                  ),
              ],
      );
}
