import 'dart:async';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show SelectableText;
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../api/chat.dart';
import '../app_scope.dart';
import '../look.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// The trader's own coding agent -- not Dave, not trading. Give it a task; it works round after
/// round (E2B sandbox + Firecrawl) until it says it's done, the round limit, or Stop. A task can
/// also be put on a loop. Its files are in a workspace that persists between runs.
class CoderScreen extends StatefulWidget {
  const CoderScreen({super.key});

  @override
  State<CoderScreen> createState() => _CoderScreenState();
}

class _CoderScreenState extends State<CoderScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<Map<String, dynamic>> _log = [];
  Map<String, dynamic> _settings = const {};
  List<Map<String, dynamic>> _files = const [];
  bool _running = false;
  bool _loaded = false;
  String? _error;
  int _after = 0;
  Timer? _timer;
  final Set<int> _open = {};

  ChatApi get _api => ChatApi.of(AppScope.of(context).api);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _poll());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _poll() async {
    _timer?.cancel();
    try {
      final s = await _api.coderState(after: _after);
      if (!mounted) return;
      final fresh = (s['log'] as List? ?? const []).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
      final atBottom = !_scroll.hasClients || _scroll.position.pixels >= _scroll.position.maxScrollExtent - 80;
      setState(() {
        _log.addAll(fresh);
        if (_log.length > 600) _log.removeRange(0, _log.length - 600);
        if (fresh.isNotEmpty) _after = (fresh.last['id'] as num).toInt();
        _running = s['running'] == true;
        _settings = Map<String, dynamic>.from(s['settings'] as Map? ?? const {});
        _files = (s['files'] as List? ?? const []).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
        _loaded = true;
        _error = null;
      });
      if (fresh.isNotEmpty && atBottom) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients) _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
    if (!mounted) return;
    // Fast while it works; slower when idle (a loop can start it on its own).
    _timer = Timer(Duration(milliseconds: _running ? 1500 : 6000), () {
      if (mounted && TickerMode.valuesOf(context).enabled) {
        _poll();
      } else if (mounted) {
        _timer = Timer(const Duration(seconds: 6), _poll);
      }
    });
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    HapticFeedback.selectionClick();
    try {
      await _api.coderSend(text);
      _input.clear();
      setState(() => _running = true);
      await _poll();
    } catch (e) {
      if (mounted) await showError(context, e);
    }
  }

  Future<void> _stop() async {
    try {
      await _api.coderStop();
      await _poll();
    } catch (e) {
      if (mounted) await showError(context, e);
    }
  }

  Future<void> _menu() async {
    final choice = await showCupertinoModalPopup<String>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        actions: [
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'settings'), child: const Text('AI, rounds and loop')),
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, 'files'), child: Text('Files (${_files.length})')),
          CupertinoActionSheetAction(isDestructiveAction: true, onPressed: () => Navigator.pop(ctx, 'reset'), child: const Text('New conversation')),
        ],
        cancelButton: CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'settings') {
      await pushScoped<void>(context, _CoderSettingsPage(api: _api, settings: _settings));
      await _poll();
    } else if (choice == 'files') {
      await Navigator.of(context).push(CupertinoPageRoute<void>(builder: (_) => _FilesPage(api: _api, files: _files)));
    } else if (choice == 'reset') {
      if (!await confirmDestructive(context, title: 'Start a new conversation?', message: 'The agent forgets this conversation. Its files stay in the workspace.', action: 'Start over')) return;
      await _api.coderReset();
      setState(() {
        _log.clear();
        _after = 0;
      });
      await _poll();
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final loop = _settings['loop'] is Map ? Map<String, dynamic>.from(_settings['loop'] as Map) : null;
    final ai = _settings['provider'] == null ? "Dave's main AI" : '${_settings['provider']}${_settings['model'] != null ? ' · ${_settings['model']}' : ''}';
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      navigationBar: CupertinoNavigationBar(
        backgroundColor: look.base.withValues(alpha: 0.82),
        middle: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Coding agent'),
          Text(_running ? 'Working…' : 'Idle', style: TextStyle(fontSize: 11, color: _running ? look.accent : secondary)),
        ]),
        trailing: CupertinoButton(key: const ValueKey('coder-menu'), padding: EdgeInsets.zero, onPressed: _menu, child: const Icon(CupertinoIcons.ellipsis_circle)),
      ),
      child: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.s3, 6, Space.s3, 2),
            child: Row(children: [
              Icon(CupertinoIcons.sparkles, size: 13, color: secondary),
              const SizedBox(width: 4),
              Expanded(child: Text('$ai · up to ${_settings['maxRounds'] ?? 30} rounds${loop != null ? ' · loop every ${loop['everyMinutes']} min' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, color: secondary))),
            ]),
          ),
          Expanded(
            child: !_loaded
                ? Center(child: _error != null ? Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center)) : const CupertinoActivityIndicator())
                : _log.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(28),
                          child: Text(
                            'Give it a task -- build a script, scrape a site, analyse a file, write an app. It runs code in an E2B sandbox, searches and reads the web with Firecrawl, and keeps going until the job is done.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: secondary, height: 1.4),
                          ),
                        ),
                      )
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(Space.s3, 8, Space.s3, 12),
                        itemCount: _log.length,
                        itemBuilder: (_, i) => _entry(_log[i]),
                      ),
          ),
          Container(
            // Room for the floating tab bar under it (hidden while the keyboard is up).
            padding: EdgeInsets.fromLTRB(Space.s3, 8, Space.s3, MediaQuery.viewInsetsOf(context).bottom > 0 ? 10 : 82),
            decoration: BoxDecoration(color: look.card, border: Border(top: BorderSide(color: look.line))),
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Expanded(
                child: CupertinoTextField(
                  key: const ValueKey('coder-input'),
                  controller: _input,
                  placeholder: _running ? 'It is working -- Stop to change course' : 'A task, or "continue"',
                  minLines: 1,
                  maxLines: 6,
                  enabled: !_running,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(18)),
                ),
              ),
              const SizedBox(width: 8),
              CupertinoButton(
                key: ValueKey(_running ? 'coder-stop' : 'coder-send'),
                padding: const EdgeInsets.all(10),
                minimumSize: const Size(40, 40),
                color: _running ? look.down : look.accent,
                borderRadius: BorderRadius.circular(20),
                onPressed: _running ? _stop : _send,
                child: Icon(_running ? CupertinoIcons.stop_fill : CupertinoIcons.arrow_up, size: 18, color: look.tabActiveIcon),
              ),
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _entry(Map<String, dynamic> e) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final id = (e['id'] as num?)?.toInt() ?? 0;
    final kind = '${e['kind']}';
    switch (kind) {
      case 'user':
        return Align(
          alignment: Alignment.centerRight,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 6),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            constraints: const BoxConstraints(maxWidth: 520),
            decoration: BoxDecoration(color: look.accent.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(16)),
            child: SelectableText('${e['text'] ?? ''}', style: const TextStyle(fontSize: 14.5)),
          ),
        );
      case 'tool_start':
      case 'tool_end':
        final end = kind == 'tool_end';
        final isErr = e['isError'] == true;
        final open = _open.contains(id);
        final detail = '${end ? (e['result'] ?? '') : (e['args'] ?? '')}';
        return GestureDetector(
          onTap: () => setState(() => open ? _open.remove(id) : _open.add(id)),
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 2),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(10)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Icon(end ? (isErr ? CupertinoIcons.xmark_circle : CupertinoIcons.checkmark_circle) : CupertinoIcons.play_circle, size: 14, color: end ? (isErr ? look.down : look.up) : look.accent),
                const SizedBox(width: 6),
                Text('${e['name']}', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, fontFamily: 'Menlo')),
                const SizedBox(width: 6),
                Expanded(child: Text(end ? (e['ms'] != null ? '${((e['ms'] as num) / 1000).toStringAsFixed(1)}s' : '') : detail.replaceAll('\n', ' '), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, color: secondary, fontFamily: 'Menlo'))),
                Icon(open ? CupertinoIcons.chevron_up : CupertinoIcons.chevron_down, size: 12, color: secondary),
              ]),
              if (open)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: SelectableText(detail, style: const TextStyle(fontSize: 11.5, fontFamily: 'Menlo', height: 1.35)),
                ),
            ]),
          ),
        );
      case 'final':
        return Container(
          margin: const EdgeInsets.symmetric(vertical: 8),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: look.up.withValues(alpha: 0.10), borderRadius: BorderRadius.circular(14), border: Border.all(color: look.up.withValues(alpha: 0.4))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [Icon(CupertinoIcons.checkmark_seal_fill, size: 16, color: look.up), const SizedBox(width: 6), Text('Task complete', style: TextStyle(fontWeight: FontWeight.w700, color: look.up))]),
            const SizedBox(height: 6),
            SelectableText('${e['text'] ?? ''}', style: const TextStyle(fontSize: 14.5, height: 1.4)),
          ]),
        );
      case 'notice':
      case 'error':
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text('${e['text'] ?? ''}', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: kind == 'error' ? look.down : secondary)),
        );
      default:
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: SelectableText('${e['text'] ?? ''}', style: const TextStyle(fontSize: 14.5, height: 1.4)),
        );
    }
  }
}

/// Which AI it uses, how many rounds a task gets, and the loop.
class _CoderSettingsPage extends StatefulWidget {
  const _CoderSettingsPage({required this.api, required this.settings});
  final ChatApi api;
  final Map<String, dynamic> settings;

  @override
  State<_CoderSettingsPage> createState() => _CoderSettingsPageState();
}

class _CoderSettingsPageState extends State<_CoderSettingsPage> {
  late Map<String, dynamic> _s = Map.of(widget.settings);

  Future<void> _save(Map<String, Object?> patch) async {
    try {
      final r = await widget.api.coderSettings(patch);
      if (mounted) setState(() => _s = Map<String, dynamic>.from(r['settings'] as Map));
    } catch (e) {
      if (mounted) await showError(context, e);
    }
  }

  Future<void> _pickAi() async {
    final api = AppScope.of(context).api;
    final list = await api.providers();
    if (!mounted) return;
    final withKeys = list.providers.where((p) => p.keyCount > 0).toList();
    final provider = await showCupertinoModalPopup<String>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: const Text('Coding agent AI'),
        message: const Text('Any provider you have a key for. "Dave\'s main AI" follows whatever Dave uses, with its backups.'),
        actions: [
          CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, ''), child: const Text("Dave's main AI")),
          for (final p in withKeys) CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx, p.provider), child: Text(p.name)),
        ],
        cancelButton: CupertinoActionSheetAction(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
      ),
    );
    if (provider == null || !mounted) return;
    if (provider.isEmpty) return _save({'provider': null, 'model': null});
    List<String> models = const [];
    try {
      models = await api.providerModels(provider);
    } catch (_) {}
    if (!mounted) return;
    String? model;
    if (models.isNotEmpty) {
      model = await showCupertinoModalPopup<String>(
        context: context,
        builder: (ctx) => _ModelSheet(models: models),
      );
      if (model == null) return;
    } else {
      model = await promptText(context, title: 'Model', message: 'Type the model id (leave empty for the key\'s own model).', placeholder: 'e.g. deepseek/deepseek-v4-pro');
    }
    await _save({'provider': provider, 'model': (model ?? '').isEmpty ? null : model});
  }

  @override
  Widget build(BuildContext context) {
    final loop = _s['loop'] is Map ? Map<String, dynamic>.from(_s['loop'] as Map) : null;
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return CupertinoPageScaffold(
      navigationBar: const CupertinoNavigationBar(middle: Text('Coding agent')),
      child: SafeArea(
        child: ListView(padding: const EdgeInsets.all(Space.s3), children: [
          ContentCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const SectionLabel('AI'),
              CupertinoListTile(
                key: const ValueKey('coder-ai'),
                padding: EdgeInsets.zero,
                title: Text(_s['provider'] == null ? "Dave's main AI" : '${_s['provider']}'),
                subtitle: _s['model'] != null ? Text('${_s['model']}') : null,
                trailing: const CupertinoListTileChevron(),
                onTap: _pickAi,
              ),
            ]),
          ),
          ContentCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const SectionLabel('Rounds'),
              Text('A task keeps going round after round until the agent says it is done. This is the most rounds one task gets.', style: TextStyle(fontSize: 12.5, color: secondary)),
              const SizedBox(height: 8),
              Row(children: [
                CupertinoButton(padding: EdgeInsets.zero, onPressed: () => _save({'maxRounds': ((_s['maxRounds'] as num?) ?? 30) - 5}), child: const Icon(CupertinoIcons.minus_circle)),
                Expanded(child: Text('${_s['maxRounds'] ?? 30} rounds', textAlign: TextAlign.center, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700))),
                CupertinoButton(padding: EdgeInsets.zero, onPressed: () => _save({'maxRounds': ((_s['maxRounds'] as num?) ?? 30) + 5}), child: const Icon(CupertinoIcons.plus_circle)),
              ]),
            ]),
          ),
          ContentCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const SectionLabel('Loop'),
              Text(loop == null ? 'Run a task again and again on a timer -- e.g. "check the site and fix anything broken" every 60 minutes.' : 'Every ${loop['everyMinutes']} min: ${loop['task']}', style: TextStyle(fontSize: 13, color: loop == null ? secondary : null)),
              const SizedBox(height: 8),
              Row(children: [
                CupertinoButton(
                  key: const ValueKey('coder-loop-set'),
                  padding: EdgeInsets.zero,
                  onPressed: () async {
                    final task = await promptText(context, title: 'Loop task', message: 'What it should do each time.', initial: '${loop?['task'] ?? ''}', action: 'Next');
                    if (task == null || task.trim().isEmpty || !context.mounted) return;
                    final mins = await promptText(context, title: 'How often?', message: 'Minutes between runs.', initial: '${loop?['everyMinutes'] ?? 60}', keyboardType: TextInputType.number);
                    final m = int.tryParse(mins ?? '');
                    if (m == null || m < 1) return;
                    await _save({'loop': {'task': task.trim(), 'everyMinutes': m}});
                  },
                  child: Text(loop == null ? 'Set a loop' : 'Change'),
                ),
                if (loop != null) ...[
                  const SizedBox(width: 20),
                  CupertinoButton(padding: EdgeInsets.zero, onPressed: () => _save({'loop': null}), child: const Text('Turn off', style: TextStyle(color: CupertinoColors.systemRed))),
                ],
              ]),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _ModelSheet extends StatefulWidget {
  const _ModelSheet({required this.models});
  final List<String> models;
  @override
  State<_ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<_ModelSheet> {
  String _q = '';
  @override
  Widget build(BuildContext context) {
    final shown = widget.models.where((m) => m.toLowerCase().contains(_q.toLowerCase())).take(200).toList();
    return CupertinoPopupSurface(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: SafeArea(
          child: Column(children: [
            Padding(padding: const EdgeInsets.all(12), child: CupertinoSearchTextField(autofocus: true, onChanged: (v) => setState(() => _q = v))),
            Expanded(
              child: ListView(children: [
                for (final m in shown) CupertinoListTile(title: Text(m, style: const TextStyle(fontSize: 14)), onTap: () => Navigator.pop(context, m)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

/// The workspace: every file the agent made, tap to save or share it.
class _FilesPage extends StatelessWidget {
  const _FilesPage({required this.api, required this.files});
  final ChatApi api;
  final List<Map<String, dynamic>> files;

  String _size(num b) => b > 1024 * 1024 ? '${(b / 1024 / 1024).toStringAsFixed(1)} MB' : b > 1024 ? '${(b / 1024).toStringAsFixed(1)} KB' : '$b B';

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      navigationBar: const CupertinoNavigationBar(middle: Text('Workspace files')),
      child: SafeArea(
        child: files.isEmpty
            ? const Center(child: Text('No files yet.'))
            : ListView(children: [
                for (final f in files)
                  CupertinoListTile(
                    leading: const Icon(CupertinoIcons.doc_text),
                    title: Text('${f['path']}', style: const TextStyle(fontFamily: 'Menlo', fontSize: 13.5)),
                    subtitle: Text(_size((f['bytes'] as num?) ?? 0)),
                    trailing: const Icon(CupertinoIcons.square_arrow_up, size: 18),
                    onTap: () async {
                      try {
                        final bytes = await api.coderFile('${f['path']}');
                        final dir = await Directory.systemTemp.createTemp('coder-');
                        final file = File('${dir.path}/${'${f['path']}'.split('/').last}');
                        await file.writeAsBytes(bytes);
                        await SharePlus.instance.share(ShareParams(files: [XFile(file.path)]));
                      } catch (e) {
                        if (context.mounted) await showError(context, e);
                      }
                    },
                  ),
              ]),
      ),
    );
  }
}
