import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Nous: copy trading from the trader's Telegram signal channels -- everything /nous does in
/// Telegram. Log Telegram in, pick the channels and groups, set the options, see what came in.
///
/// The api_hash, login code and 2-step password are typed here and sent to the server once; they
/// are never stored on the phone.
class NousPage extends StatelessWidget {
  const NousPage({super.key});

  @override
  Widget build(BuildContext context) => LoadedPage<NousState>(
        title: 'Nous',
        load: (api) => api.nous(),
        builder: (context, n, reload) {
          Future<void> act(String path, [Map<String, Object?> body = const {}]) async {
            if (await runAction(context, (api) => api.nousAction(path, body))) await reload();
          }

          final blue = resolve(context, CupertinoColors.systemBlue);
          return [
            SliverToBoxAdapter(
              child: _Section(
                header: 'Telegram',
                footer: n.loggedIn
                    ? 'Nous reads only the channels and groups you pick -- never your private chats.'
                    : 'Nous reads your signal channels by logging in as you: a bot can\'t read channels you only follow.',
                children: [
                  CupertinoListTile(
                    leading: Icon(CupertinoIcons.paperplane_fill, color: resolve(context, n.loggedIn ? CupertinoColors.systemBlue : CupertinoColors.secondaryLabel)),
                    title: Text(n.loggedIn ? (n.account ?? 'Connected') : 'Not connected'),
                    subtitle: n.loggedIn ? Text(n.listening ? 'Reading ${n.chats.length} ${n.chats.length == 1 ? 'chat' : 'chats'}' : 'Not reading yet') : null,
                    trailing: n.loggedIn ? Pill(text: n.listening ? 'Live' : 'Idle', good: n.listening) : null,
                  ),
                  CupertinoListTile(
                    leading: Icon(CupertinoIcons.link, color: blue),
                    title: Text(n.loggedIn ? 'Reconnect Telegram' : 'Connect Telegram', style: TextStyle(color: blue)),
                    trailing: const CupertinoListTileChevron(),
                    onTap: () async {
                      final done = await pushScoped<bool>(context, const NousConnectPage());
                      if (done == true && context.mounted) await pushScoped<void>(context, const NousChannelsPage());
                      await reload();
                    },
                  ),
                  if (n.loggedIn)
                    CupertinoListTile(
                      leading: const Icon(CupertinoIcons.antenna_radiowaves_left_right),
                      title: const Text('Channels & groups'),
                      subtitle: Text(n.chats.isEmpty ? 'None picked yet' : n.chats.map((c) => c.title).join(', '), maxLines: 2, overflow: TextOverflow.ellipsis),
                      trailing: const CupertinoListTileChevron(),
                      onTap: () async {
                        await pushScoped<void>(context, const NousChannelsPage());
                        await reload();
                      },
                    ),
                ],
              ),
            ),
            SliverToBoxAdapter(
              child: _Section(
                header: 'How Nous trades',
                footer: 'Takes TP1 first. At TP1 the stop moves to entry and the target to TP2. If a trade loses for 5 minutes or margin gets tight, Dave checks whether the setup is still valid. Old signals and ones whose entry has passed are never placed.',
                children: [
                  CupertinoListTile(
                    leading: const Icon(CupertinoIcons.bolt_fill),
                    title: const Text('Auto-approve'),
                    subtitle: Text(n.autoApprove ? 'Places signals without asking' : 'Asks you Place / Skip for each one'),
                    trailing: CupertinoSwitch(value: n.autoApprove, onChanged: (v) => act('settings', {'autoApprove': v})),
                  ),
                  CupertinoListTile(
                    leading: const Icon(CupertinoIcons.cube_box),
                    title: const Text('Lots per signal'),
                    additionalInfo: Text(n.lotsAuto ? 'Auto (${_lots(n.lots)})' : _lots(n.lots)),
                    trailing: const CupertinoListTileChevron(),
                    onTap: () async {
                      final s = await promptText(context,
                          title: 'Lots per signal',
                          message: 'From 0.01 to 100. Leave empty for Auto: Dave\'s fixed lot, or 0.01 when that\'s off.',
                          initial: n.lotsAuto ? '' : _lots(n.lots),
                          placeholder: 'Auto',
                          keyboardType: const TextInputType.numberWithOptions(decimal: true));
                      if (s == null || !context.mounted) return;
                      await act('settings', {'lots': s.isEmpty ? null : double.tryParse(s.replaceAll(',', '.')) ?? s});
                    },
                  ),
                  CupertinoListTile(
                    leading: const Icon(CupertinoIcons.timer),
                    title: const Text('Ignore signals older than'),
                    additionalInfo: Text('${n.maxAgeMinutes} min'),
                    trailing: const CupertinoListTileChevron(),
                    onTap: () async {
                      final s = await promptText(context, title: 'Maximum signal age', message: 'Minutes, from 1 to 60.', initial: '${n.maxAgeMinutes}', keyboardType: TextInputType.number);
                      if (s == null || s.isEmpty || !context.mounted) return;
                      await act('settings', {'maxAgeMinutes': int.tryParse(s) ?? s});
                    },
                  ),
                ],
              ),
            ),
            if (n.trades.isNotEmpty)
              SliverToBoxAdapter(
                child: _Section(
                  header: 'Open Nous trades',
                  children: [
                    for (final t in n.trades)
                      CupertinoListTile(
                        leading: Icon(t.isBuy ? CupertinoIcons.arrow_up_right : CupertinoIcons.arrow_down_right),
                        title: Text('${t.symbol}  ${t.isBuy ? 'Buy' : 'Sell'}  ${_lots(t.lots)}'),
                        subtitle: Text('Entry ${formatPrice(t.entry)} · SL ${formatPrice(t.sl)} · TP1 ${formatPrice(t.tp1)}${t.tp2 == null ? '' : ' · TP2 ${formatPrice(t.tp2!)}'}\nFrom ${t.from}', maxLines: 2),
                        trailing: CupertinoButton(
                          padding: EdgeInsets.zero,
                          onPressed: () async {
                            final ok = await confirmDestructive(context, title: 'Close ${t.symbol} #${t.ticket}?', message: 'Closes it at the market price now.', action: 'Close trade');
                            if (ok && context.mounted) await act('close', {'ticket': t.ticket});
                          },
                          child: Text('Close', style: TextStyle(color: resolve(context, CupertinoColors.systemRed))),
                        ),
                      ),
                  ],
                ),
              ),
            if (n.signals.isNotEmpty)
              SliverToBoxAdapter(
                child: _Section(
                  header: 'Recent signals',
                  children: [
                    for (final s in n.signals)
                      CupertinoListTile(
                        title: Text('${s.symbol}  ${s.isBuy ? 'Buy' : 'Sell'}'),
                        subtitle: Text([s.from, if (s.postedAt != null) formatAgo(s.postedAt!)].join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis),
                        additionalInfo: Text(_status(s.status), style: TextStyle(color: resolve(context, _statusColor(s.status)))),
                      ),
                  ],
                ),
              ),
            if (n.loggedIn)
              SliverToBoxAdapter(
                child: _Section(
                  children: [
                    CupertinoListTile(
                      title: Text('Log out of Telegram', style: TextStyle(color: resolve(context, CupertinoColors.systemRed))),
                      onTap: () async {
                        final ok = await confirmDestructive(context,
                            title: 'Log Nous out?', message: 'Nous stops reading your channels, and the session disappears from Telegram\'s Devices list.', action: 'Log out');
                        if (ok && context.mounted) await act('logout');
                      },
                    ),
                  ],
                ),
              ),
          ];
        },
      );

  static String _lots(double v) => v.toStringAsFixed(2);

  static String _status(String s) => switch (s) {
        'awaiting' => 'Waiting for you',
        'placed' => 'Placed',
        'skipped' => 'Skipped',
        'expired' => 'Too old',
        'failed' => 'Failed',
        _ => s,
      };

  static Color _statusColor(String s) => switch (s) {
        'placed' => CupertinoColors.systemGreen,
        'awaiting' => CupertinoColors.systemBlue,
        'failed' => CupertinoColors.systemRed,
        _ => CupertinoColors.secondaryLabel,
      };
}

/// A glass list section, like every other settings list.
class _Section extends StatelessWidget {
  const _Section({this.header, this.footer, required this.children});
  final String? header;
  final String? footer;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => CupertinoListSection.insetGrouped(
        backgroundColor: const Color(0x00000000),
        decoration: glassDecoration(context, radius: 14),
        separatorColor: resolve(context, CupertinoColors.separator).withValues(alpha: 0.4),
        header: header == null ? null : ListHeader(header!),
        footer: footer == null ? null : ListFooter(footer!),
        children: children,
      );
}

/// Logging Telegram in, one step at a time: the app keys, the code Telegram sends, and the
/// 2-step password when the account has one. Pops `true` once connected.
class NousConnectPage extends StatefulWidget {
  const NousConnectPage({super.key});

  @override
  State<NousConnectPage> createState() => _NousConnectPageState();
}

enum _Step { keys, code, password }

class _NousConnectPageState extends State<NousConnectPage> {
  final _apiId = TextEditingController();
  final _apiHash = TextEditingController();
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _password = TextEditingController();
  _Step _step = _Step.keys;
  bool _busy = false;
  bool _done = false;
  String? _error;
  DaveApi? _api;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _api = AppScope.of(context).api;
  }

  @override
  void dispose() {
    // Leaving half-way ends the login on the server too.
    if (!_done && _step != _Step.keys) _api?.nousAction('login/cancel').ignore();
    for (final c in [_apiId, _apiHash, _phone, _code, _password]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    final scope = AppScope.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      switch (_step) {
        case _Step.keys:
          await scope.api.nousAction('login/begin', {'apiId': _apiId.text.trim(), 'apiHash': _apiHash.text.trim(), 'phone': _phone.text.trim()});
          setState(() => _step = _Step.code);
        case _Step.code:
          final r = await scope.api.nousAction('login/code', {'code': _code.text});
          if (r['needPassword'] == true) {
            setState(() => _step = _Step.password);
          } else {
            _finish();
          }
        case _Step.password:
          final r = await scope.api.nousAction('login/password', {'password': _password.text});
          _password.clear();
          if (r['done'] == true) _finish();
      }
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _finish() {
    _done = true;
    HapticFeedback.mediumImpact();
    if (mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final (title, action) = switch (_step) {
      _Step.keys => ('Connect Telegram', 'Send me the code'),
      _Step.code => ('Enter the code', 'Continue'),
      _Step.password => ('Two-step password', 'Connect'),
    };
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      navigationBar: CupertinoNavigationBar(middle: Text(title)),
      child: SafeArea(
        child: ListView(padding: const EdgeInsets.only(bottom: Space.s6), children: [
          if (_step == _Step.keys) ...[
            _Section(
              header: 'First, your API keys (free, one minute)',
              children: const [
                _Instruction(n: 1, text: 'Open my.telegram.org in your browser and log in with your phone number.'),
                _Instruction(n: 2, text: 'Tap API development tools. Fill in any app name (e.g. Nous) and a short name, then create it.'),
                _Instruction(n: 3, text: 'Copy App api_id (a number) and App api_hash (letters and numbers) into the boxes below.'),
              ],
            ),
            _Section(
              footer: 'The api_hash goes to your Dave server only and is stored encrypted there -- never on this phone.',
              children: [
                _Field(controller: _apiId, label: 'api_id', placeholder: '1234567', keyboard: TextInputType.number),
                _Field(controller: _apiHash, label: 'api_hash', placeholder: '32 letters and numbers', obscure: true),
                _Field(controller: _phone, label: 'Phone', placeholder: '+2348012345678', keyboard: TextInputType.phone),
              ],
            ),
          ],
          if (_step == _Step.code)
            _Section(
              footer: 'Telegram just sent a login code to your Telegram app (a message from "Telegram"). Type it here -- no need for spaces.',
              children: [_Field(controller: _code, label: 'Code', placeholder: '12345', keyboard: TextInputType.number, autofocus: true)],
            ),
          if (_step == _Step.password)
            _Section(
              footer: 'Your account has two-step verification. This is the password you set for it in Telegram. It is sent once and not kept.',
              children: [_Field(controller: _password, label: 'Password', placeholder: 'Required', obscure: true, autofocus: true)],
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(Space.s5, Space.s2, Space.s5, 0),
              child: Text(_error!, style: TextStyle(fontSize: 14, color: resolve(context, CupertinoColors.systemRed))),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.s4, Space.s4, Space.s4, 0),
            child: CupertinoButton.filled(
              onPressed: _busy ? null : _submit,
              borderRadius: BorderRadius.circular(14),
              child: _busy ? const CupertinoActivityIndicator(color: CupertinoColors.white) : Text(action),
            ),
          ),
        ]),
      ),
    );
  }
}

class _Instruction extends StatelessWidget {
  const _Instruction({required this.n, required this.text});
  final int n;
  final String text;
  @override
  Widget build(BuildContext context) => CupertinoListTile(
        padding: const EdgeInsetsDirectional.fromSTEB(20, 12, 14, 12),
        leading: Container(
          width: 26,
          height: 26,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: resolve(context, CupertinoColors.systemBlue).withValues(alpha: 0.14), shape: BoxShape.circle),
          child: Text('$n', style: TextStyle(fontWeight: FontWeight.w700, color: resolve(context, CupertinoColors.systemBlue))),
        ),
        title: Text(text, maxLines: 3, style: const TextStyle(fontSize: 15)),
      );
}

class _Field extends StatelessWidget {
  const _Field({required this.controller, required this.label, required this.placeholder, this.keyboard = TextInputType.text, this.obscure = false, this.autofocus = false});
  final TextEditingController controller;
  final String label;
  final String placeholder;
  final TextInputType keyboard;
  final bool obscure;
  final bool autofocus;

  @override
  Widget build(BuildContext context) => CupertinoListTile(
        title: Row(children: [
          SizedBox(width: 84, child: Text(label)),
          Expanded(
            child: CupertinoTextField(
              controller: controller,
              placeholder: placeholder,
              keyboardType: keyboard,
              obscureText: obscure,
              autofocus: autofocus,
              autocorrect: false,
              enableSuggestions: false,
              decoration: null,
              padding: const EdgeInsets.symmetric(vertical: 10),
            ),
          ),
        ]),
      );
}

/// Picking the channels and groups Nous reads.
class NousChannelsPage extends StatefulWidget {
  const NousChannelsPage({super.key});

  @override
  State<NousChannelsPage> createState() => _NousChannelsPageState();
}

class _NousChannelsPageState extends State<NousChannelsPage> {
  List<NousChat>? _chats;
  String? _error;
  String _query = '';
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final scope = AppScope.of(context);
    setState(() => _error = null);
    try {
      final chats = await scope.api.nousChats();
      if (mounted) setState(() => _chats = chats);
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _save() async {
    final chats = _chats;
    if (chats == null) return;
    final scope = AppScope.of(context);
    setState(() => _saving = true);
    try {
      final state = await scope.api.saveNousChats([for (final c in chats) if (c.picked) c.id]);
      if (!mounted) return;
      HapticFeedback.mediumImpact();
      final picked = state.chats.map((c) => c.title).join(', ');
      await showCupertinoDialog<void>(
        context: context,
        builder: (ctx) => CupertinoAlertDialog(
          title: Text(state.chats.isEmpty ? 'Nothing picked' : (state.listening ? 'Nous is reading' : 'Saved')),
          content: Text(state.chats.isEmpty
              ? 'Nous won\'t read anything until you pick a channel or group.'
              : '$picked${state.warning != null ? '\n\nNot listening yet: ${state.warning}' : '\n\nNew signals come to you as a card to approve${state.autoApprove ? ' -- auto-approve is on, so they\'re placed straight away' : ''}.'}'),
          actions: [CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
        ),
      );
      if (mounted) Navigator.of(context).pop();
    } on UnpairedException catch (e) {
      scope.onUnpaired(e.message);
    } catch (e) {
      if (mounted) await showError(context, e);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final chats = _chats;
    final shown = chats?.where((c) => _query.isEmpty || c.title.toLowerCase().contains(_query.toLowerCase())).toList();
    final picked = chats?.where((c) => c.picked).length ?? 0;
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      navigationBar: CupertinoNavigationBar(
        middle: const Text('Channels & groups'),
        trailing: CupertinoButton(
          padding: EdgeInsets.zero,
          onPressed: chats == null || _saving ? null : _save,
          child: _saving ? const CupertinoActivityIndicator() : const Text('Save', style: TextStyle(fontWeight: FontWeight.w600)),
        ),
      ),
      child: SafeArea(
        child: chats == null
            ? Center(
                child: _error == null
                    ? const CupertinoActivityIndicator(radius: 14)
                    : EmptyState(
                        icon: CupertinoIcons.wifi_exclamationmark,
                        title: 'Could not list your chats',
                        message: _error!,
                        action: CupertinoButton.filled(onPressed: _load, child: const Text('Try again')),
                      ),
              )
            : ListView(padding: const EdgeInsets.only(bottom: Space.s6), children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(Space.s4, Space.s3, Space.s4, 0),
                  child: CupertinoSearchTextField(onChanged: (v) => setState(() => _query = v.trim())),
                ),
                _Section(
                  header: '$picked picked',
                  footer: 'Only channels and groups are listed. Your private chats are never read.',
                  children: [
                    if (shown!.isEmpty) const CupertinoListTile(title: Text('No channels or groups match')),
                    for (final c in shown)
                      CupertinoListTile(
                        leading: Icon(c.isChannel ? CupertinoIcons.speaker_2_fill : CupertinoIcons.person_3_fill,
                            color: resolve(context, c.picked ? CupertinoColors.systemBlue : CupertinoColors.secondaryLabel)),
                        title: Text(c.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(c.isChannel ? 'Channel' : 'Group'),
                        trailing: Icon(c.picked ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.circle,
                            color: resolve(context, c.picked ? CupertinoColors.systemBlue : CupertinoColors.tertiaryLabel)),
                        onTap: () {
                          HapticFeedback.selectionClick();
                          setState(() => c.picked = !c.picked);
                        },
                      ),
                  ],
                ),
              ]),
      ),
    );
  }
}
