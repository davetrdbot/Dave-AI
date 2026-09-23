import 'package:flutter/cupertino.dart';
// Only this one widget, so a skill's text can be selected and copied. None of Material's
// styling comes with it.
import 'package:flutter/material.dart' show SelectableText;
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Trading-strategy skills: see what is installed, read one, switch the active strategy, and
/// install a new one from GitHub.
///
/// Activating a skill here is the one thing the app can do that Dave may NOT do on his own -- the
/// trading prompt forbids him from switching strategy by himself, because that is the trader's
/// call. This is the trader making it.
class SkillsScreen extends StatefulWidget {
  const SkillsScreen({super.key});

  @override
  State<SkillsScreen> createState() => _SkillsScreenState();
}

class _SkillsScreenState extends State<SkillsScreen> {
  // Bumping the key rebuilds LoadedPage, i.e. reloads -- used after an install from the nav bar,
  // which lives outside the page's own reload callback.
  var _generation = 0;

  /// "+" offers both ways to add a skill: write one by hand, or install one from GitHub.
  Future<void> _add() async {
    final choice = await showCupertinoModalPopup<String>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: const Text('Add a skill'),
        actions: [
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'write'), child: const Text('Write a skill')),
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'github'), child: const Text('Install from GitHub')),
        ],
        cancelButton: CupertinoActionSheetAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
      ),
    );
    if (!mounted) return;
    if (choice == 'write') await _write();
    if (choice == 'github') await _install();
  }

  Future<void> _write() async {
    final api = AppScope.of(context).api;
    final saved = await pushScoped<bool>(
      context,
      EditorPage(
        title: 'New skill',
        saveLabel: 'Create',
        fields: const [
          EditorField(label: 'Name', placeholder: 'London breakout'),
          EditorField(label: 'Description', placeholder: 'One line: what the strategy is', required: false),
          EditorField(label: 'Strategy', placeholder: 'The complete rules Dave should follow: bias, entry, stop, target, when not to trade.', multiline: true, monospace: true),
        ],
        footer: 'Write it the way you would explain it to another trader. Dave follows it exactly once you make it the active strategy.',
        onSave: (v) => api.createSkill(name: v[0], description: v[1], content: v[2]),
      ),
    );
    if (saved == true && mounted) setState(() => _generation++);
  }

  Future<void> _install() async {
    final url = await showCupertinoDialog<String>(context: context, builder: (_) => const _InstallDialog());
    if (url == null || url.trim().isEmpty || !mounted) return;
    final scope = AppScope.of(context);
    try {
      await scope.api.installSkillFromGithub(url.trim());
      HapticFeedback.mediumImpact();
      if (mounted) setState(() => _generation++);
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) await showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return LoadedPage<List<Skill>>(
      key: ValueKey(_generation),
      title: 'Skills',
      trailing: CupertinoButton(
        padding: EdgeInsets.zero,
        onPressed: _add,
        child: const Icon(CupertinoIcons.add, semanticLabel: 'Add a skill'),
      ),
      load: (api) => api.skills(),
      builder: (context, skills, reload) {
        if (skills.isEmpty) {
          return [
            SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: EmptyState(
                  icon: CupertinoIcons.square_stack_3d_up,
                  title: 'No skills yet',
                  message: 'A skill is a complete trading strategy Dave can follow. Write your own or install one from GitHub.',
                  action: CupertinoButton.filled(onPressed: _add, child: const Text('Add a skill')),
                ),
              ),
            ),
          ];
        }
        final active = skills.where((s) => s.active).toList();
        return [
          SliverToBoxAdapter(
            child: CupertinoListSection.insetGrouped(
              header: const ListHeader('ACTIVE STRATEGY'),
              footer: ListFooter(active.isEmpty
                  ? 'No strategy active -- Dave trades on his own judgment and default analysis.'
                  : 'Dave follows this strategy exactly on every trade until you switch it off.'),
              children: [
                if (active.isEmpty)
                  CupertinoListTile(title: Text('None', style: TextStyle(color: resolve(context, CupertinoColors.secondaryLabel))))
                else
                  _SkillTile(skill: active.first, onChanged: reload),
              ],
            ),
          ),
          SliverToBoxAdapter(
            child: CupertinoListSection.insetGrouped(
              header: ListHeader('ALL SKILLS  ${skills.length}'),
              children: [for (final s in skills) _SkillTile(skill: s, onChanged: reload)],
            ),
          ),
        ];
      },
    );
  }
}

class _SkillTile extends StatelessWidget {
  const _SkillTile({required this.skill, required this.onChanged});
  final Skill skill;
  final Future<void> Function() onChanged;

  @override
  Widget build(BuildContext context) => CupertinoListTile(
        leading: Icon(skill.active ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.circle,
            color: resolve(context, skill.active ? CupertinoColors.systemBlue : CupertinoColors.tertiaryLabel)),
        title: Text(skill.name),
        subtitle: skill.description.isEmpty ? null : Text(skill.description, maxLines: 2),
        trailing: const CupertinoListTileChevron(),
        onTap: () async {
          final scope = AppScope.of(context);
          await Navigator.of(context).push(CupertinoPageRoute<void>(builder: (_) => AppScope(api: scope.api, onUnpaired: scope.onUnpaired, child: SkillDetail(id: skill.id, name: skill.name))));
          await onChanged();
        },
      );
}

class _InstallDialog extends StatefulWidget {
  const _InstallDialog();

  @override
  State<_InstallDialog> createState() => _InstallDialogState();
}

class _InstallDialogState extends State<_InstallDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CupertinoAlertDialog(
        title: const Text('Install from GitHub'),
        content: Padding(
          padding: const EdgeInsets.only(top: Space.s3),
          child: Column(children: [
            const Text('Paste the address of a GitHub repository that contains a SKILL.md.'),
            const SizedBox(height: Space.s3),
            CupertinoTextField(
              controller: _controller,
              placeholder: 'https://github.com/owner/repo',
              keyboardType: TextInputType.url,
              autocorrect: false,
              autofocus: true,
            ),
          ]),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(context, _controller.text), child: const Text('Install')),
        ],
      );
}

/// One skill, read in full. Reading it activates nothing.
class SkillDetail extends StatefulWidget {
  const SkillDetail({super.key, required this.id, required this.name});
  final String id;
  final String name;

  @override
  State<SkillDetail> createState() => _SkillDetailState();
}

class _SkillDetailState extends State<SkillDetail> {
  Skill? _skill;
  Object? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final scope = AppScope.of(context);
    try {
      final s = await scope.api.skill(widget.id);
      if (mounted) setState(() => _skill = s);
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _run(Future<void> Function(DaveApi api) action, {bool pop = false}) async {
    final scope = AppScope.of(context);
    setState(() => _busy = true);
    try {
      await action(scope.api);
      HapticFeedback.mediumImpact();
      if (!mounted) return;
      if (pop) {
        Navigator.of(context).pop();
      } else {
        await _load();
      }
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) await showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _skill;
    return CupertinoPageScaffold(
      backgroundColor: resolve(context, CupertinoColors.systemGroupedBackground),
      navigationBar: CupertinoNavigationBar(middle: Text(widget.name, overflow: TextOverflow.ellipsis)),
      child: SafeArea(
        child: s == null
            ? Center(child: _error == null ? const CupertinoActivityIndicator() : EmptyState(icon: CupertinoIcons.exclamationmark_triangle, title: 'Could not load', message: '$_error'))
            : ListView(padding: const EdgeInsets.only(top: Space.s3, bottom: Space.s6), children: [
                if (s.description.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: Space.s5, vertical: Space.s2),
                    child: Text(s.description, style: TextStyle(fontSize: 15, color: resolve(context, CupertinoColors.secondaryLabel))),
                  ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: Space.s4, vertical: Space.s2),
                  child: s.active
                      ? CupertinoButton(color: resolve(context, CupertinoColors.systemGrey5), onPressed: _busy ? null : () => _run((api) => api.deactivateSkill()), child: Text('Stop using this strategy', style: TextStyle(color: resolve(context, CupertinoColors.label))))
                      : CupertinoButton.filled(onPressed: _busy ? null : () => _run((api) => api.activateSkill(s.id)), child: const Text('Use this strategy')),
                ),
                if (!s.permanent)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: Space.s4),
                    child: CupertinoButton(
                      onPressed: _busy
                          ? null
                          : () async {
                              final api = AppScope.of(context).api;
                              final saved = await pushScoped<bool>(
                                context,
                                EditorPage(
                                  title: 'Edit ${s.name}',
                                  fields: [EditorField(label: 'Strategy', initial: s.content ?? '', multiline: true, monospace: true)],
                                  onSave: (v) => api.updateSkill(s.id, v[0]),
                                ),
                              );
                              if (saved == true) await _load();
                            },
                      child: const Text('Edit strategy'),
                    ),
                  ),
                ContentCard(
                  child: SelectableText(
                    s.content ?? '',
                    style: TextStyle(fontFamily: 'monospace', fontSize: 13, height: 1.45, color: resolve(context, CupertinoColors.label)),
                  ),
                ),
                if (!s.permanent)
                  Padding(
                    padding: const EdgeInsets.all(Space.s4),
                    child: CupertinoButton(
                      onPressed: _busy
                          ? null
                          : () async {
                              final ok = await confirmDestructive(context, title: 'Delete "${s.name}"?', message: 'The skill is removed from Dave. This cannot be undone.', action: 'Delete skill');
                              if (ok) await _run((api) => api.deleteSkill(s.id), pop: true);
                            },
                      child: Text('Delete skill', style: TextStyle(color: resolve(context, CupertinoColors.systemRed))),
                    ),
                  ),
              ]),
      ),
    );
  }
}
