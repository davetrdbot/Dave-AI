import 'dart:convert';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/cupertino.dart';

import '../api/chat.dart';
import '../app_scope.dart';
import '../look.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// One player for the whole app: a new "say this" stops whatever Dave was saying before.
class DaveAudio {
  DaveAudio._();
  static AudioPlayer? _player;
  static final ValueNotifier<String?> playing = ValueNotifier(null);

  /// Plays base64 audio from the server; [id] marks what is playing (a message, a voice preview).
  static Future<void> play(String base64Audio, {required String id}) async {
    final player = _player ??= AudioPlayer();
    await player.stop();
    playing.value = id;
    player.onPlayerComplete.first.then((_) {
      if (playing.value == id) playing.value = null;
    });
    await player.play(BytesSource(base64Decode(base64Audio), mimeType: 'audio/mpeg'));
  }

  static Future<void> stop() async {
    playing.value = null;
    await _player?.stop();
  }
}

/// Settings → Dave's voice: ElevenLabs and Fish Audio. Keys, which one leads (the other is the
/// automatic fallback), the voice for each, and a preview. The same setup Telegram voice replies use.
class DaveVoicePage extends StatelessWidget {
  const DaveVoicePage({super.key});

  @override
  Widget build(BuildContext context) {
    return LoadedPage<Map<String, dynamic>>(
      title: "Dave's voice",
      load: (api) => api.voice(),
      builder: (context, v, reload) {
        final api = AppScope.of(context).api;
        final look = Look.of(context);
        final secondary = resolve(context, CupertinoColors.secondaryLabel);
        final providers = ((v['providers'] as List?) ?? const []).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
        final active = '${v['activeProvider']}';
        final enabled = v['enabled'] == true;
        Future<void> act(Map<String, Object?> body) async {
          try {
            await api.voiceAction(body);
          } catch (e) {
            if (context.mounted) await showError(context, e);
          }
          await reload();
        }

        return [
          SliverToBoxAdapter(
            child: ContentCard(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(shape: BoxShape.circle, gradient: look.hero),
                    child: Icon(CupertinoIcons.waveform, color: look.heroText),
                  ),
                  const SizedBox(width: Space.s3),
                  const Expanded(child: Text('Dave speaks', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800))),
                  CupertinoSwitch(key: const ValueKey('voice-enabled'), value: enabled, activeTrackColor: look.accent, onChanged: (x) => act({'action': 'enabled', 'enabled': x})),
                ]),
                const SizedBox(height: Space.s2),
                Text('Reads his replies aloud in the app (tap the speaker on a message), sends voice notes in Telegram, and can be his voice on calls.',
                    style: TextStyle(fontSize: 13, color: secondary)),
                const SizedBox(height: Space.s3),
                Text('LEADS · the other takes over if it fails', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1, color: secondary)),
                const SizedBox(height: 6),
                Container(
                  padding: const EdgeInsets.all(3),
                  decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(12)),
                  child: Row(children: [
                    for (final p in providers)
                      Expanded(
                        child: GestureDetector(
                          onTap: () => act({'action': 'provider', 'provider': p['id']}),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 150),
                            padding: const EdgeInsets.symmetric(vertical: 10),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(color: p['id'] == active ? look.accent : null, borderRadius: BorderRadius.circular(9)),
                            child: Text('${p['name']}', style: TextStyle(fontWeight: FontWeight.w700, color: p['id'] == active ? look.tabActiveIcon : null)),
                          ),
                        ),
                      ),
                  ]),
                ),
              ]),
            ),
          ),
          for (final p in providers) SliverToBoxAdapter(child: _ProviderCard(p: p, active: p['id'] == active, act: act, reload: reload)),
          SliverToBoxAdapter(child: _SpeechToTextCard(s: (v['speechToText'] as Map?)?.cast<String, dynamic>() ?? const {}, act: act)),
          SliverToBoxAdapter(child: _GeminiLiveCard(g: (v['geminiLive'] as Map?)?.cast<String, dynamic>() ?? const {}, act: act)),
          const SliverToBoxAdapter(child: SizedBox(height: 110)),
        ];
      },
    );
  }
}

class _ProviderCard extends StatelessWidget {
  const _ProviderCard({required this.p, required this.active, required this.act, required this.reload});
  final Map<String, dynamic> p;
  final bool active;
  final Future<void> Function(Map<String, Object?>) act;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final hasKey = p['key'] != null;
    final voiceId = p['voiceId'] as String?;
    return ContentCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text('${p['name']}', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800))),
          if (active)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
              decoration: BoxDecoration(color: look.accent.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(20)),
              child: Text('LEADS', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: look.accent)),
            ),
        ]),
        Text('${p['about']}', style: TextStyle(fontSize: 12.5, color: secondary)),
        const SizedBox(height: Space.s3),
        _Row(
          icon: CupertinoIcons.lock_fill,
          title: 'API key',
          value: hasKey ? '${p['key']}' : 'Not added',
          onTap: () async {
            final key = await promptText(context, title: '${p['name']} API key', message: 'From ${p['link']}', placeholder: 'Paste the key', obscure: true, action: 'Save');
            if (key != null && key.isNotEmpty) await act({'action': 'key', 'provider': p['id'], 'apiKey': key});
          },
          trailing: hasKey
              ? GestureDetector(
                  onTap: () async {
                    final ok = await confirmDestructive(context, title: 'Remove the ${p['name']} key?', message: 'Dave stops using ${p['name']}.', action: 'Remove');
                    if (ok) await act({'action': 'remove-key', 'provider': p['id']});
                  },
                  child: Icon(CupertinoIcons.trash, size: 18, color: look.down),
                )
              : null,
        ),
        _Row(
          icon: CupertinoIcons.person_crop_circle,
          title: 'Voice',
          value: voiceId ?? 'Pick one',
          enabled: hasKey,
          onTap: !hasKey
              ? null
              : () async {
                  await pushScoped<void>(context, _VoicePicker(provider: '${p['id']}', name: '${p['name']}', current: voiceId));
                  await reload();
                },
        ),
      ]),
    );
  }
}

/// Your voice into text: Groq Whisper (the mic in the chat, and voice notes in Telegram).
class _SpeechToTextCard extends StatelessWidget {
  const _SpeechToTextCard({required this.s, required this.act});
  final Map<String, dynamic> s;
  final Future<void> Function(Map<String, Object?>) act;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final key = s['key'] as String?;
    final link = '${s['link'] ?? 'https://console.groq.com/keys'}';
    return ContentCard(
      key: const ValueKey('speech-to-text-card'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: Text('Speech to text · Groq Whisper', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800))),
          if (key != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
              decoration: BoxDecoration(color: look.accent.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(20)),
              child: Text('READY', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: look.accent)),
            ),
        ]),
        Text('Tap the mic in the chat and talk -- Groq turns your voice into text (it knows your pairs and trading words), Dave answers out loud in the voice above. Also used for your Telegram voice notes.',
            style: TextStyle(fontSize: 12.5, color: secondary)),
        const SizedBox(height: Space.s3),
        _Row(
          icon: CupertinoIcons.lock_fill,
          title: 'Groq API key',
          value: key ?? 'Not added',
          onTap: () async {
            final k = await promptText(context, title: 'Groq API key', message: 'Create one free at $link, then paste it here. It starts with gsk_.', placeholder: 'gsk_...', obscure: true, action: 'Save');
            if (k != null && k.isNotEmpty) await act({'action': 'groq-key', 'apiKey': k});
          },
          trailing: key != null
              ? GestureDetector(
                  onTap: () async {
                    final ok = await confirmDestructive(context, title: 'Remove the Groq key?', message: 'Talking to Dave and Telegram voice notes stop being turned into text.', action: 'Remove');
                    if (ok) await act({'action': 'remove-groq-key'});
                  },
                  child: Icon(CupertinoIcons.trash, size: 18, color: look.down),
                )
              : null,
        ),
      ]),
    );
  }
}

/// Talking to Dave live (Gemini Live): the one key it needs.
class _GeminiLiveCard extends StatelessWidget {
  const _GeminiLiveCard({required this.g, required this.act});
  final Map<String, dynamic> g;
  final Future<void> Function(Map<String, Object?>) act;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final key = g['key'] as String?;
    final link = '${g['link'] ?? 'https://aistudio.google.com/app/apikey'}';
    return ContentCard(
      key: const ValueKey('gemini-live-card'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: Text('Talk to Dave live · Gemini', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800))),
          if (key != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
              decoration: BoxDecoration(color: look.accent.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(20)),
              child: Text('READY', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: look.accent)),
            ),
        ]),
        Text('Speak to Dave and interrupt him, like a phone call -- he hears you, thinks and uses his tools while you talk. Needs a Gemini API key (free to create).',
            style: TextStyle(fontSize: 12.5, color: secondary)),
        const SizedBox(height: Space.s3),
        _Row(
          icon: CupertinoIcons.lock_fill,
          title: 'Gemini API key',
          value: key ?? 'Not added',
          onTap: () async {
            final k = await promptText(context, title: 'Gemini API key', message: 'Create one free at $link (Google AI Studio > Get API key), then paste it here. It starts with AIza.', placeholder: 'AIza...', obscure: true, action: 'Save');
            if (k != null && k.isNotEmpty) await act({'action': 'gemini-key', 'apiKey': k});
          },
          trailing: key != null
              ? GestureDetector(
                  onTap: () async {
                    final ok = await confirmDestructive(context, title: 'Remove the Gemini key?', message: 'Live calls with Dave stop working until you add one again.', action: 'Remove');
                    if (ok) await act({'action': 'remove-gemini-key'});
                  },
                  child: Icon(CupertinoIcons.trash, size: 18, color: look.down),
                )
              : null,
        ),
        const SizedBox(height: Space.s2),
        Text('Dave can also CALL you: your phone rings like a WhatsApp call (even with the app closed) and answering opens this live call, with Dave saying why he called.',
            style: TextStyle(fontSize: 12.5, color: secondary)),
        _Row(
          key: const ValueKey('test-call'),
          icon: CupertinoIcons.phone_arrow_down_left,
          title: 'Ring me now (test call)',
          value: key == null ? 'Add the key first' : '',
          enabled: key != null,
          onTap: key == null
              ? null
              : () async {
                  try {
                    await ChatApi.of(AppScope.of(context).api).testCall();
                  } catch (e) {
                    if (context.mounted) await showError(context, e);
                  }
                },
        ),
      ]),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({super.key, required this.icon, required this.title, required this.value, this.onTap, this.trailing, this.enabled = true});
  final IconData icon;
  final String title;
  final String value;
  final VoidCallback? onTap;
  final Widget? trailing;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Opacity(
        opacity: enabled ? 1 : 0.45,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(children: [
            Icon(icon, size: 18, color: Look.of(context).accent),
            const SizedBox(width: Space.s3),
            Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const SizedBox(width: Space.s3),
            Expanded(child: Text(value, textAlign: TextAlign.right, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: secondary))),
            const SizedBox(width: 8),
            trailing ?? Icon(CupertinoIcons.chevron_right, size: 15, color: secondary),
          ]),
        ),
      ),
    );
  }
}

/// Every voice the key can use -- the account's own clones first -- each with a play button.
class _VoicePicker extends StatefulWidget {
  const _VoicePicker({required this.provider, required this.name, this.current});
  final String provider;
  final String name;
  final String? current;

  @override
  State<_VoicePicker> createState() => _VoicePickerState();
}

class _VoicePickerState extends State<_VoicePicker> {
  List<Map<String, dynamic>>? _voices;
  String? _error;
  String _query = '';
  String? _busy;
  late String? _current = widget.current;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final r = await AppScope.of(context).api.voiceAction({'action': 'voices', 'provider': widget.provider, 'query': _query});
      if (mounted) setState(() => (_voices = ((r['voices'] as List?) ?? const []).cast<Map>().map((m) => m.cast<String, dynamic>()).toList(), _error = null));
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _preview(String id) async {
    setState(() => _busy = id);
    try {
      final r = await AppScope.of(context).api.voiceAction({'action': 'preview', 'provider': widget.provider, 'voiceId': id});
      await DaveAudio.play('${r['audio']}', id: 'preview-$id');
    } catch (e) {
      if (mounted) await showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _choose(String id) async {
    try {
      await AppScope.of(context).api.voiceAction({'action': 'voice', 'provider': widget.provider, 'voiceId': id});
      if (mounted) setState(() => _current = id);
    } catch (e) {
      if (mounted) await showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final voices = _voices;
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      child: CustomScrollView(slivers: [
        CupertinoSliverNavigationBar(largeTitle: Text('${widget.name} voices')),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(Space.s4, Space.s2, Space.s4, Space.s2),
            child: CupertinoTextField(
              placeholder: 'Search voices',
              prefix: Padding(padding: const EdgeInsets.only(left: 10), child: Icon(CupertinoIcons.search, size: 16, color: secondary)),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
              decoration: BoxDecoration(color: look.chip, borderRadius: BorderRadius.circular(12)),
              onSubmitted: (q) {
                _query = q;
                _load();
              },
            ),
          ),
        ),
        if (_error != null)
          SliverToBoxAdapter(child: Padding(padding: const EdgeInsets.all(Space.s4), child: Text(_error!, style: TextStyle(color: look.down))))
        else if (voices == null)
          const SliverToBoxAdapter(child: Padding(padding: EdgeInsets.all(40), child: CupertinoActivityIndicator()))
        else
          SliverList.builder(
            itemCount: voices.length,
            itemBuilder: (context, i) {
              final v = voices[i];
              final id = '${v['voiceId']}';
              final chosen = id == _current;
              return GestureDetector(
                key: ValueKey('voice-$id'),
                behavior: HitTestBehavior.opaque,
                onTap: () => _choose(id),
                child: Container(
                  margin: const EdgeInsets.fromLTRB(Space.s4, 3, Space.s4, 3),
                  padding: const EdgeInsets.symmetric(horizontal: Space.s3, vertical: 10),
                  decoration: glassDecoration(context, radius: 14),
                  child: Row(children: [
                    ValueListenableBuilder<String?>(
                      valueListenable: DaveAudio.playing,
                      builder: (context, playing, _) => GestureDetector(
                        onTap: () => playing == 'preview-$id' ? DaveAudio.stop() : _preview(id),
                        child: Container(
                          width: 38,
                          height: 38,
                          decoration: BoxDecoration(shape: BoxShape.circle, color: look.accent.withValues(alpha: 0.16)),
                          child: _busy == id
                              ? const CupertinoActivityIndicator(radius: 8)
                              : Icon(playing == 'preview-$id' ? CupertinoIcons.stop_fill : CupertinoIcons.play_fill, size: 16, color: look.accent),
                        ),
                      ),
                    ),
                    const SizedBox(width: Space.s3),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('${v['name']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: chosen ? FontWeight.w800 : FontWeight.w600)),
                        Text(v['mine'] == true ? 'Your voice' : id, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, color: v['mine'] == true ? look.accent : secondary)),
                      ]),
                    ),
                    if (chosen) Icon(CupertinoIcons.checkmark_alt, color: look.accent),
                  ]),
                ),
              );
            },
          ),
        const SliverToBoxAdapter(child: SizedBox(height: 60)),
      ]),
    );
  }
}
