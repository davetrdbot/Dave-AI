import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../session.dart';
import '../theme.dart';

/// The one-time "power up": the server address and a pairing code, entered once per phone.
///
/// After this the app holds a token and never asks again until the phone is disconnected -- which
/// is why the address is remembered even then, so reconnecting means typing only a new code.
class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key, required this.onConnected, this.notice});

  final void Function(Uri endpoint, String token) onConnected;

  /// Why the phone ended up here, if it was disconnected rather than never paired.
  final String? notice;

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  final _address = TextEditingController();
  final _code = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    Session.lastEndpoint().then((e) {
      if (e != null && mounted && _address.text.isEmpty) _address.text = Uri.parse(e).host;
    });
  }

  @override
  void dispose() {
    _address.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    FocusScope.of(context).unfocus();
    final endpoint = normaliseEndpoint(_address.text);
    if (endpoint == null) {
      setState(() => _error = 'That does not look like a server address. It should look like your-app.up.railway.app');
      return;
    }
    final code = _code.text.trim();
    if (code.length != 6) {
      setState(() => _error = 'The pairing code is 6 characters. Get one from the Phone App tab in the web panel.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await DaveApi.pair(endpoint, code, 'Android phone');
      await Session.save(endpoint, result.token);
      HapticFeedback.mediumImpact();
      widget.onConnected(endpoint, result.token);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return CupertinoPageScaffold(
      backgroundColor: resolve(context, CupertinoColors.systemGroupedBackground),
      child: SafeArea(
        child: ListView(padding: const EdgeInsets.fromLTRB(Space.s5, Space.s6, Space.s5, Space.s6), children: [
          Icon(CupertinoIcons.chart_bar_square_fill, size: 56, color: resolve(context, CupertinoColors.systemBlue)),
          const SizedBox(height: Space.s4),
          const Text('Connect to Dave', textAlign: TextAlign.center, style: TextStyle(fontSize: 30, fontWeight: FontWeight.w700, letterSpacing: -0.6)),
          const SizedBox(height: Space.s2),
          Text(
            'In the web panel, open Phone App and tap Get a pairing code. Enter the server address and the code here. You only do this once.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 15, color: secondary),
          ),
          if (widget.notice != null) ...[
            const SizedBox(height: Space.s4),
            Container(
              padding: const EdgeInsets.all(Space.s3),
              decoration: BoxDecoration(color: resolve(context, CupertinoColors.systemOrange).withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
              child: Text(widget.notice!, style: TextStyle(fontSize: 14, color: resolve(context, CupertinoColors.label))),
            ),
          ],
          const SizedBox(height: Space.s5),
          CupertinoFormSection.insetGrouped(
            margin: EdgeInsets.zero,
            children: [
              CupertinoTextFormFieldRow(
                controller: _address,
                prefix: const Text('Server'),
                placeholder: 'your-app.up.railway.app',
                keyboardType: TextInputType.url,
                autocorrect: false,
                enableSuggestions: false,
                textInputAction: TextInputAction.next,
              ),
              CupertinoTextFormFieldRow(
                controller: _code,
                prefix: const Text('Code'),
                placeholder: 'ABC234',
                textCapitalization: TextCapitalization.characters,
                autocorrect: false,
                enableSuggestions: false,
                maxLength: 6,
                style: const TextStyle(letterSpacing: 3, fontWeight: FontWeight.w600),
                onFieldSubmitted: (_) => _connect(),
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: Space.s3),
            Text(_error!, style: TextStyle(fontSize: 14, color: resolve(context, CupertinoColors.systemRed))),
          ],
          const SizedBox(height: Space.s5),
          SizedBox(
            height: 50,
            child: CupertinoButton.filled(
              onPressed: _busy ? null : _connect,
              child: _busy ? const CupertinoActivityIndicator(color: CupertinoColors.white) : const Text('Connect'),
            ),
          ),
        ]),
      ),
    );
  }
}
