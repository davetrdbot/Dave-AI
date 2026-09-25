import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../app_scope.dart';
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
          SliverToBoxAdapter(
            child: _Entries(title: 'About you', target: 'user', icon: CupertinoIcons.person, entries: b.userFacts, empty: 'Nothing saved about you yet.', reload: reload),
          ),
          SliverToBoxAdapter(child: _Entries(title: 'Notes', target: 'memory', icon: CupertinoIcons.doc_text, entries: b.notes, empty: 'No notes yet.', reload: reload)),
          SliverToBoxAdapter(child: _Knowledge(items: b.knowledge, reload: reload)),
          SliverToBoxAdapter(child: _ResetMemory(reload: reload)),
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

/// A tappable "Add ..." row at the end of a list.
class _AddRow extends StatelessWidget {
  const _AddRow({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final blue = resolve(context, CupertinoColors.systemBlue);
    return CupertinoListTile(
      leading: Icon(CupertinoIcons.plus_circle_fill, color: blue),
      title: Text(label, style: TextStyle(color: blue)),
      onTap: onTap,
    );
  }
}

/// Memory entries, editable. Every change goes through the same memory store Dave writes to,
/// under the same size budget -- so an entry typed here is exactly as if Dave had saved it.
class _Entries extends StatelessWidget {
  const _Entries({required this.title, required this.target, required this.icon, required this.entries, required this.empty, required this.reload});
  final String title;
  final String target; // "user" | "memory"
  final IconData icon;
  final List<String> entries;
  final String empty;
  final Future<void> Function() reload;

  Future<void> _edit(BuildContext context, {String? existing}) async {
    final api = AppScope.of(context).api;
    final saved = await pushScoped<bool>(
      context,
      EditorPage(
        title: existing == null ? 'Add to ${title.toLowerCase()}' : 'Edit',
        fields: [EditorField(label: title, initial: existing ?? '', placeholder: target == 'user' ? 'Something Dave should know about you' : 'Something Dave should remember', multiline: true)],
        onSave: (v) async {
          if (existing == null) {
            await api.brainAction('memory-add', {'target': target, 'content': v[0]});
          } else {
            await api.brainAction('memory-replace', {'target': target, 'oldText': existing, 'content': v[0]});
          }
        },
      ),
    );
    if (saved == true) await reload();
  }

  Future<void> _options(BuildContext context, String entry) async {
    final choice = await showCupertinoModalPopup<String>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        message: Text(entry, maxLines: 4, overflow: TextOverflow.ellipsis),
        actions: [
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'edit'), child: const Text('Edit')),
          CupertinoActionSheetAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, 'delete'), child: const Text('Delete')),
        ],
        cancelButton: CupertinoActionSheetAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
      ),
    );
    if (!context.mounted) return;
    if (choice == 'edit') {
      await _edit(context, existing: entry);
    } else if (choice == 'delete') {
      final ok = await runAction(context, (api) => api.brainAction('memory-remove', {'target': target, 'oldText': entry}));
      if (ok) await reload();
    }
  }

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
        header: ListHeader('$title  ${entries.length}'),
        children: [
          if (entries.isEmpty) CupertinoListTile(title: Text(empty, style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel)))),
          for (final e in entries)
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => _options(context, e),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: Space.s4, vertical: Space.s3),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Padding(padding: const EdgeInsets.only(top: 2), child: Icon(icon, size: 18, color: resolve(context, ChartColors.memory))),
                  const SizedBox(width: Space.s3),
                  Expanded(child: Text(e, style: const TextStyle(fontSize: 15))),
                ]),
              ),
            ),
          _AddRow(label: target == 'user' ? 'Add something about you' : 'Add a note', onTap: () => _edit(context)),
        ],
      );
}

class _Knowledge extends StatelessWidget {
  const _Knowledge({required this.items, required this.reload});
  final List<KnowledgeItem> items;
  final Future<void> Function() reload;

  Future<void> _add(BuildContext context) async {
    final api = AppScope.of(context).api;
    final saved = await pushScoped<bool>(
      context,
      EditorPage(
        title: 'New lesson',
        fields: const [
          EditorField(label: 'Title', placeholder: 'Gold fades the New York open'),
          EditorField(label: 'Use when', placeholder: 'Entering XAUUSD in the first 30 minutes of New York', required: false),
          EditorField(label: 'Lesson', placeholder: 'What happens, and what to do about it', multiline: true),
        ],
        footer: '"Use when" is how Dave finds this lesson mid-trade, so say when it applies.',
        onSave: (v) => api.brainAction('knowledge-add', {'title': v[0], 'useWhen': v[1], 'content': v[2]}),
      ),
    );
    if (saved == true) await reload();
  }

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(backgroundColor: const Color(0x00000000), decoration: glassDecoration(context, radius: 14), separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4), 
        header: ListHeader('Knowledge  ${items.length}'),
        footer: const ListFooter('Lessons about markets and Dave\'s own trading. They survive a reset.'),
        children: [
          if (items.isEmpty) CupertinoListTile(title: Text('No lessons saved yet.', style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel)))),
          for (final k in items)
            CupertinoListTile(
              leading: Icon(CupertinoIcons.book, color: resolve(context, ChartColors.knowledge)),
              title: Text(k.title),
              subtitle: k.useWhen.isEmpty ? null : Text('Use when: ${k.useWhen}'),
              trailing: const CupertinoListTileChevron(),
              onTap: () async {
                final changed = await pushScoped<bool>(context, _KnowledgePage(id: k.id, title: k.title));
                if (changed == true) await reload();
              },
            ),
          _AddRow(label: 'Add a lesson', onTap: () => _add(context)),
        ],
      );
}

/// One lesson in full, with delete.
class _KnowledgePage extends StatefulWidget {
  const _KnowledgePage({required this.id, required this.title});
  final String id;
  final String title;

  @override
  State<_KnowledgePage> createState() => _KnowledgePageState();
}

class _KnowledgePageState extends State<_KnowledgePage> {
  KnowledgeDetail? _k;
  Object? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final scope = AppScope.of(context);
      try {
        final k = await scope.api.knowledge(widget.id);
        if (mounted) setState(() => _k = k);
      } catch (e) {
        if (mounted) setState(() => _error = e);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final k = _k;
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      navigationBar: CupertinoNavigationBar(middle: Text(widget.title, overflow: TextOverflow.ellipsis)),
      child: SafeArea(
        child: k == null
            ? Center(child: _error == null ? const CupertinoActivityIndicator() : EmptyState(icon: CupertinoIcons.exclamationmark_triangle, title: 'Could not load', message: '$_error'))
            : ListView(padding: const EdgeInsets.only(top: Space.s3, bottom: Space.s6), children: [
                if (k.useWhen.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: Space.s5, vertical: Space.s2),
                    child: Text('Use when: ${k.useWhen}', style: TextStyle(fontSize: 15, color: secondary)),
                  ),
                ContentCard(child: Text(k.content, style: const TextStyle(fontSize: 16, height: 1.4))),
                Padding(
                  padding: const EdgeInsets.all(Space.s4),
                  child: CupertinoButton(
                    onPressed: () async {
                      final ok = await confirmDestructive(context, title: 'Delete this lesson?', message: 'Dave will no longer use it.', action: 'Delete lesson');
                      if (!ok || !context.mounted) return;
                      if (await runAction(context, (api) => api.brainAction('knowledge-delete', {'id': k.id})) && context.mounted) Navigator.of(context).pop(true);
                    },
                    child: Text('Delete lesson', style: TextStyle(color: resolve(context, CupertinoColors.systemRed))),
                  ),
                ),
              ]),
      ),
    );
  }
}

/// Wipes what Dave knows about the trader. Knowledge is kept -- the same line Telegram's /reset
/// draws -- and the sheet says so, so nobody resets expecting their lessons to go too.
class _ResetMemory extends StatelessWidget {
  const _ResetMemory({required this.reload});
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(Space.s4, Space.s4, Space.s4, 0),
        child: CupertinoButton(
          color: resolve(context, CupertinoColors.secondarySystemGroupedBackground),
          onPressed: () async {
            final ok = await confirmDestructive(
              context,
              title: 'Reset memory?',
              message: 'Dave forgets everything in "About you" and "Notes". Knowledge (trading lessons) is kept. This cannot be undone.',
              action: 'Reset memory',
            );
            if (!ok || !context.mounted) return;
            HapticFeedback.mediumImpact();
            if (await runAction(context, (api) => api.brainAction('reset-memory'))) await reload();
          },
          child: Text('Reset memory', style: TextStyle(color: resolve(context, CupertinoColors.systemRed))),
        ),
      );
}
