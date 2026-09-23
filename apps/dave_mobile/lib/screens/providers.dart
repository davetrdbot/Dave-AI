import 'package:flutter/cupertino.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Every AI provider Dave can use (the trader: "add all the providers to the settings").
///
/// Dave answers with the MAIN provider and falls back to the BACKUPS in order when it fails. The
/// list shows exactly that order first, then providers that have keys but are not in use, then the
/// rest of the catalogue.
class ProvidersPage extends StatelessWidget {
  const ProvidersPage({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<ProviderList>(
        title: 'AI providers',
        load: (api) => api.providers(),
        builder: (context, list, reload) {
          Future<void> open(ProviderSummary p) async {
            await pushScoped<void>(context, ProviderPage(provider: p.provider, name: p.name));
            await reload();
          }

          final main = list.main;
          final backups = list.backups;
          return [
            SliverToBoxAdapter(
              child: CupertinoListSection.insetGrouped(
                header: const ListHeader('In use'),
                footer: const ListFooter('Dave answers with his main AI. If it fails or is too slow, he tries the backups in this order.'),
                children: [
                  if (main != null) _row(context, main, 'Main', () => open(main)),
                  for (final b in backups)
                    _row(context, b, 'Backup ${b.backupPosition}', () => open(b), onLongPress: () => _reorder(context, b, backups, reload)),
                  if (main == null && backups.isEmpty) const CupertinoListTile(title: Text('No provider set')),
                ],
              ),
            ),
            if (list.withKeys.isNotEmpty)
              SliverToBoxAdapter(
                child: CupertinoListSection.insetGrouped(
                  header: const ListHeader('Have keys, not in use'),
                  children: [for (final p in list.withKeys) _row(context, p, null, () => open(p))],
                ),
              ),
            SliverToBoxAdapter(
              child: CupertinoListSection.insetGrouped(
                header: ListHeader('All providers  ${list.others.length}'),
                footer: const ListFooter('Tap one to add a key. A provider joins Dave\'s order only when you make it the main AI or a backup.'),
                children: [for (final p in list.others) _row(context, p, null, () => open(p))],
              ),
            ),
          ];
        },
      );

  Widget _row(BuildContext context, ProviderSummary p, String? role, VoidCallback onTap, {VoidCallback? onLongPress}) {
    final keys = p.keyCount == 0 ? 'No keys' : '${p.keyCount} key${p.keyCount == 1 ? '' : 's'}${p.healthyKeys < p.keyCount ? ', ${p.keyCount - p.healthyKeys} failing' : ''}';
    return GestureDetector(
      onLongPress: onLongPress,
      child: CupertinoListTile(
        title: Text(p.name),
        subtitle: Text(p.keyCount == 0 ? keys : '$keys  ·  ${p.model}', maxLines: 1, overflow: TextOverflow.ellipsis),
        additionalInfo: role == null ? null : Text(role),
        trailing: const CupertinoListTileChevron(),
        onTap: onTap,
      ),
    );
  }

  Future<void> _reorder(BuildContext context, ProviderSummary b, List<ProviderSummary> backups, Future<void> Function() reload) async {
    final i = backups.indexOf(b);
    final choice = await showCupertinoModalPopup<String>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(b.name),
        message: Text('Backup ${b.backupPosition}'),
        actions: [
          if (i > 0) CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'up'), child: const Text('Try earlier')),
          if (i < backups.length - 1) CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'down'), child: const Text('Try later')),
        ],
        cancelButton: CupertinoActionSheetAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
      ),
    );
    if (choice == null || !context.mounted) return;
    if (await runAction(context, (api) => api.moveBackup(b.provider, choice))) await reload();
  }
}

/// Human names for the extra fields some providers need on a key.
const _extraLabels = {
  'accountId': ('Account ID', 'Your account ID from the provider\'s dashboard.'),
  'region': ('Region', 'The region, e.g. us-east-1.'),
  'secretAccessKey': ('Secret access key', 'The secret that goes with the access key.'),
};

/// One provider: whether Dave uses it, the model, and its keys.
class ProviderPage extends StatelessWidget {
  const ProviderPage({super.key, required this.provider, required this.name});
  final String provider;
  final String name;

  @override
  Widget build(BuildContext context) => LoadedPage<ProviderState>(
        title: name,
        load: (api) => api.provider(provider),
        builder: (context, p, reload) {
          Future<void> act(String action, [Map<String, Object?> fields = const {}]) async {
            if (await runAction(context, (api) => api.providerAction(provider, action, fields))) await reload();
          }

          final role = p.isPrimary ? 'Dave\'s main AI' : p.isBackup ? 'Backup ${p.backupPosition}' : 'Not in use';
          return [
            SliverToBoxAdapter(
              child: CupertinoListSection.insetGrouped(
                header: const ListHeader('Use'),
                footer: ListFooter(p.keys.isEmpty
                    ? 'Add a key below before Dave can use ${p.name}.'
                    : p.isPrimary
                        ? 'Dave uses ${p.name} for every answer and trade decision.'
                        : 'Making it the main AI moves the current main to the first backup, so nothing stops working.'),
                children: [
                  CupertinoListTile(
                    leading: Icon(p.isPrimary || p.isBackup ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.circle,
                        color: resolve(context, p.isPrimary || p.isBackup ? CupertinoColors.systemGreen : CupertinoColors.tertiaryLabel)),
                    title: Text(role),
                  ),
                  if (!p.isPrimary)
                    CupertinoListTile(
                      title: Text('Make ${p.name} the main AI', style: TextStyle(color: resolve(context, p.keys.isEmpty ? CupertinoColors.tertiaryLabel : CupertinoColors.systemBlue))),
                      onTap: p.keys.isEmpty ? null : () => act('make-main'),
                    ),
                  if (!p.isPrimary && !p.isBackup)
                    CupertinoListTile(
                      title: Text('Use as a backup', style: TextStyle(color: resolve(context, p.keys.isEmpty ? CupertinoColors.tertiaryLabel : CupertinoColors.systemBlue))),
                      onTap: p.keys.isEmpty ? null : () => act('add-backup'),
                    ),
                  if (p.isBackup)
                    CupertinoListTile(
                      title: Text('Stop using as a backup', style: TextStyle(color: resolve(context, CupertinoColors.systemRed))),
                      onTap: () => act('remove-backup'),
                    ),
                ],
              ),
            ),
            SliverToBoxAdapter(
              child: CupertinoListSection.insetGrouped(
                children: [
                  CupertinoListTile(
                    leading: const Icon(CupertinoIcons.cube),
                    title: const Text('Model'),
                    subtitle: Text(p.model, maxLines: 1, overflow: TextOverflow.ellipsis),
                    trailing: const CupertinoListTileChevron(),
                    onTap: p.keys.isEmpty ? null : () => _pickModel(context, p, act),
                  ),
                ],
              ),
            ),
            SliverToBoxAdapter(
              child: CupertinoListSection.insetGrouped(
                header: ListHeader('API keys  ${p.keys.length}'),
                footer: const ListFooter('With more than one key, Dave rotates to the next when one is slow or rate-limited. Keys are stored on your server and never shown in full.'),
                children: [
                  for (final k in p.keys)
                    CupertinoListTile(
                      leading: Icon(k.healthy ? CupertinoIcons.checkmark_seal_fill : CupertinoIcons.exclamationmark_circle,
                          color: resolve(context, k.healthy ? CupertinoColors.systemGreen : CupertinoColors.systemOrange)),
                      title: Text('${k.label}${k.isPrimary ? '  ·  first' : ''}'),
                      subtitle: Text(k.lastError ?? k.maskedKey, maxLines: 1, overflow: TextOverflow.ellipsis),
                      trailing: const CupertinoListTileChevron(),
                      onTap: () => _keyOptions(context, k, act),
                    ),
                  CupertinoListTile(
                    leading: Icon(CupertinoIcons.plus_circle_fill, color: resolve(context, CupertinoColors.systemBlue)),
                    title: Text('Add a key', style: TextStyle(color: resolve(context, CupertinoColors.systemBlue))),
                    onTap: () => _addKey(context, p, act),
                  ),
                ],
              ),
            ),
          ];
        },
      );

  Future<void> _addKey(BuildContext context, ProviderState p, Future<void> Function(String, [Map<String, Object?>]) act) async {
    final key = await promptText(context, title: 'Add a ${p.name} key', message: 'Paste an API key from your ${p.name} account.', placeholder: 'API key', action: 'Add');
    if (key == null || key.isEmpty || !context.mounted) return;
    final fields = <String, Object?>{'apiKey': key};
    for (final extra in p.requiresExtraConfig) {
      final label = _extraLabels[extra] ?? (extra, '');
      final value = await promptText(context, title: label.$1, message: label.$2, placeholder: label.$1, action: 'Next');
      if (value == null || value.isEmpty || !context.mounted) return;
      fields[extra] = value;
    }
    await act('add-key', fields);
  }

  Future<void> _pickModel(BuildContext context, ProviderState p, Future<void> Function(String, [Map<String, Object?>]) act) async {
    Future<void> typeIt() async {
      final model = await promptText(context, title: 'Model', message: 'The model id, exactly as ${p.name} lists it.', initial: p.model, placeholder: p.defaultModel);
      if (model != null && model.isNotEmpty && context.mounted) await act('set-model', {'model': model});
    }

    if (p.manualModelEntry) return typeIt();
    final picked = await pushScoped<String>(context, _ModelPickerPage(provider: p.provider, name: p.name, current: p.model));
    if (!context.mounted) return;
    if (picked == _typeOwn) return typeIt();
    if (picked != null && picked != p.model) await act('set-model', {'model': picked});
  }

  Future<void> _keyOptions(BuildContext context, ProviderKey k, Future<void> Function(String, [Map<String, Object?>]) act) async {
    final choice = await showCupertinoModalPopup<String>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(k.label),
        message: Text(k.maskedKey),
        actions: [
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'check'), child: const Text('Test this key')),
          if (!k.isPrimary) CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'primary'), child: const Text('Try this key first')),
          CupertinoActionSheetAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, 'remove'), child: const Text('Remove key')),
        ],
        cancelButton: CupertinoActionSheetAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
      ),
    );
    if (!context.mounted || choice == null) return;
    if (choice == 'remove' && !await confirmDestructive(context, title: 'Remove this key?', message: 'Dave stops using it straight away.', action: 'Remove')) return;
    await act(switch (choice) { 'check' => 'check-key', 'primary' => 'make-primary-key', _ => 'remove-key' }, {'keyId': k.id});
  }
}

const _typeOwn = '\u0000type';

/// The provider's own model list, searchable, with a way out to type an id it doesn't list.
class _ModelPickerPage extends StatefulWidget {
  const _ModelPickerPage({required this.provider, required this.name, required this.current});
  final String provider;
  final String name;
  final String current;

  @override
  State<_ModelPickerPage> createState() => _ModelPickerPageState();
}

class _ModelPickerPageState extends State<_ModelPickerPage> {
  String _query = '';

  @override
  Widget build(BuildContext context) => LoadedPage<List<String>>(
        title: 'Model',
        load: (DaveApi api) => api.providerModels(widget.provider),
        builder: (context, models, reload) {
          final shown = models.where((m) => m.toLowerCase().contains(_query.toLowerCase())).toList()..sort();
          return [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, 0),
                child: CupertinoSearchTextField(onChanged: (v) => setState(() => _query = v), placeholder: 'Search ${models.length} models'),
              ),
            ),
            SliverToBoxAdapter(
              child: CupertinoListSection.insetGrouped(
                footer: ListFooter(models.isEmpty ? '${widget.name} did not return a model list. Type the model id instead.' : 'The list comes from ${widget.name} itself.'),
                children: [
                  for (final m in shown)
                    CupertinoListTile(
                      title: Text(m, maxLines: 2, overflow: TextOverflow.ellipsis),
                      trailing: m == widget.current ? Icon(CupertinoIcons.check_mark, color: resolve(context, CupertinoColors.systemBlue)) : null,
                      onTap: () => Navigator.pop(context, m),
                    ),
                  CupertinoListTile(
                    title: Text('Type a model id', style: TextStyle(color: resolve(context, CupertinoColors.systemBlue))),
                    onTap: () => Navigator.pop(context, _typeOwn),
                  ),
                ],
              ),
            ),
          ];
        },
      );
}
