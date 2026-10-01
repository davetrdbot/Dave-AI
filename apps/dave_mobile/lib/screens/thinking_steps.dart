import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../look.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Settings -> How Dave works -> Thinking steps. The steps (tags) of Dave's thinking pass: each
/// one on or off, delete it, add your own. Every step that is on is mandatory -- Dave can't finish
/// thinking until he has written a real thought for each.
class ThinkingStepsPage extends StatelessWidget {
  const ThinkingStepsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return LoadedPage<Map<String, dynamic>>(
      title: 'Thinking steps',
      load: (api) => api.thinkingStages(),
      trailing: Builder(
        builder: (context) => CupertinoButton(
          key: const ValueKey('thinking-step-add'),
          padding: EdgeInsets.zero,
          onPressed: () => _add(context),
          child: const Icon(CupertinoIcons.add),
        ),
      ),
      builder: (context, data, reload) {
        final stages = ((data['stages'] as List?) ?? const []).cast<Map<String, dynamic>>();
        final look = Look.of(context);
        return [
          CupertinoListSection.insetGrouped(
            backgroundColor: const Color(0x00000000),
            decoration: glassDecoration(context, radius: 14),
            separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4),
            header: const ListHeader('Steps'),
            footer: const ListFooter('Every step that is on is mandatory: Dave writes a real thought for each before he decides. Swipe left or tap the bin to delete. + adds your own step.'),
            children: [
              for (final st in stages)
                Dismissible(
                  key: ValueKey('step-${st['id']}'),
                  direction: DismissDirection.endToStart,
                  confirmDismiss: (_) => _delete(context, st, reload),
                  background: Container(
                    alignment: Alignment.centerRight,
                    padding: const EdgeInsets.only(right: Space.s4),
                    color: CupertinoColors.systemRed,
                    child: const Icon(CupertinoIcons.delete, color: CupertinoColors.white),
                  ),
                  child: CupertinoListTile(
                    title: Text(st['label'] as String? ?? st['id'] as String),
                    subtitle: Text(st['help'] as String? ?? '', maxLines: 2, overflow: TextOverflow.ellipsis),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      CupertinoSwitch(
                        activeTrackColor: look.accent,
                        value: st['enabled'] == true,
                        onChanged: (v) => _act(context, {'action': 'toggle', 'id': st['id'], 'enabled': v}, reload),
                      ),
                      CupertinoButton(
                        padding: const EdgeInsets.only(left: 6),
                        minimumSize: const Size(30, 30),
                        onPressed: () async {
                          if (await _delete(context, st, reload)) {}
                        },
                        child: Icon(CupertinoIcons.delete, size: 18, color: resolve(context, CupertinoColors.systemRed)),
                      ),
                    ]),
                  ),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Space.s4, vertical: Space.s2),
            child: CupertinoButton(
              onPressed: () async {
                final ok = await confirmDestructive(context, title: 'Reset steps?', message: 'Back to the built-in steps -- the ones you added are removed.', action: 'Reset');
                if (ok && context.mounted) await _act(context, {'action': 'reset'}, reload);
              },
              child: const Text('Reset to built-in steps'),
            ),
          ),
        ];
      },
    );
  }

  static Future<void> _act(BuildContext context, Map<String, Object?> body, Future<void> Function() reload) async {
    final ok = await runAction(context, (api) => api.thinkingStagesAction(body));
    if (ok) {
      HapticFeedback.selectionClick();
      await reload();
    }
  }

  static Future<bool> _delete(BuildContext context, Map<String, dynamic> st, Future<void> Function() reload) async {
    final ok = await confirmDestructive(context, title: 'Delete "${st['label']}"?', message: 'Dave stops thinking about this step.', action: 'Delete');
    if (!ok || !context.mounted) return false;
    await _act(context, {'action': 'delete', 'id': st['id']}, reload);
    return false; // the reload rebuilds the list
  }

  static Future<void> _add(BuildContext context) async {
    final label = await promptText(context, title: 'New step', message: 'A short name, e.g. "News" or "Session".', placeholder: 'Name');
    if (label == null || label.isEmpty || !context.mounted) return;
    final help = await promptText(context, title: label, message: 'What must Dave think about in this step?', placeholder: 'e.g. is a high-impact news event due in the next hour');
    if (help == null || help.isEmpty || !context.mounted) return;
    final ok = await runAction(context, (api) => api.thinkingStagesAction({'action': 'add', 'label': label, 'help': help}));
    if (ok && context.mounted) {
      HapticFeedback.mediumImpact();
      // LoadedPage reloads itself when its route is revisited; nudge it by popping and pushing.
      Navigator.of(context).pushReplacement(CupertinoPageRoute<void>(builder: (_) => const ThinkingStepsPage()));
    }
  }
}
