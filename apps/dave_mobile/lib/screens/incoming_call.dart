import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/chat.dart';
import 'voice.dart';

/// Dave is calling (the trader: "it will call me, like a WhatsApp call -- inside or outside the
/// app"). Full screen: who, why, pulsing rings, Decline / Answer. Answering opens the Gemini Live
/// call where Dave speaks first; declining or letting it ring out tells Dave, so he writes instead.
class IncomingCallPage extends StatefulWidget {
  const IncomingCallPage({super.key, required this.api, required this.callId, required this.reason, this.symbol = '', this.urgent = false});
  final ChatApi api;
  final String callId;
  final String reason;
  final String symbol;
  final bool urgent;

  /// Shows the ringing screen once per call (a call can arrive through two paths at once).
  static final Set<String> _shown = {};
  static Future<void> show(NavigatorState nav, {required ChatApi api, required String callId, required String reason, String symbol = '', bool urgent = false}) async {
    if (!_shown.add(callId)) return;
    await nav.push(PageRouteBuilder<void>(
      opaque: true,
      fullscreenDialog: true,
      transitionDuration: const Duration(milliseconds: 260),
      pageBuilder: (_, _, _) => IncomingCallPage(api: api, callId: callId, reason: reason, symbol: symbol, urgent: urgent),
      transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
    ));
  }

  @override
  State<IncomingCallPage> createState() => _IncomingCallPageState();
}

class _IncomingCallPageState extends State<IncomingCallPage> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))..repeat();
  Timer? _buzz;
  Timer? _timeout;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    // Ring pattern: two buzzes every 1.5 s, and give up (missed) after 45 s like a real call.
    _buzz = Timer.periodic(const Duration(milliseconds: 1500), (_) async {
      HapticFeedback.heavyImpact();
      await Future<void>.delayed(const Duration(milliseconds: 180));
      HapticFeedback.heavyImpact();
    });
    SystemSound.play(SystemSoundType.alert);
    _timeout = Timer(const Duration(seconds: 45), () => _finish('missed'));
  }

  @override
  void dispose() {
    _buzz?.cancel();
    _timeout?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  Future<void> _finish(String status) async {
    if (_done) return;
    _done = true;
    _buzz?.cancel();
    _timeout?.cancel();
    unawaited(widget.api.callStatus(widget.callId, status).catchError((_) {}));
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _answer() async {
    if (_done) return;
    _done = true;
    _buzz?.cancel();
    _timeout?.cancel();
    HapticFeedback.mediumImpact();
    final options = await LiveOptions.load();
    if (!mounted) return;
    // The live call replaces the ringing screen; live/start with the call id marks it answered.
    await Navigator.of(context).pushReplacement(CupertinoPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => LiveCallPage(api: widget.api, options: options, callId: widget.callId),
    ));
  }

  @override
  Widget build(BuildContext context) {
    const green = Color(0xFF30D158), red = Color(0xFFFF453A);
    return CupertinoPageScaffold(
      backgroundColor: const Color(0xFF0B0F14),
      child: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFF14202B), Color(0xFF0B0F14), Color(0xFF07090C)]),
        ),
        child: SafeArea(
          child: Column(children: [
            const SizedBox(height: 28),
            Text(widget.urgent ? 'Urgent call' : 'Gemini Live call', style: const TextStyle(color: Color(0xB3FFFFFF), fontSize: 14, letterSpacing: 0.4)),
            const SizedBox(height: 40),
            SizedBox(
              width: 220,
              height: 220,
              child: AnimatedBuilder(
                animation: _pulse,
                builder: (_, _) => CustomPaint(
                  painter: _Rings(_pulse.value, widget.urgent ? red : green),
                  child: Center(
                    child: Container(
                      width: 116,
                      height: 116,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: const LinearGradient(colors: [Color(0xFF2C7BE5), Color(0xFF6C4BEF)], begin: Alignment.topLeft, end: Alignment.bottomRight),
                        boxShadow: [BoxShadow(color: const Color(0xFF2C7BE5).withValues(alpha: 0.45), blurRadius: 30)],
                      ),
                      child: const Center(child: Text('D', style: TextStyle(color: CupertinoColors.white, fontSize: 52, fontWeight: FontWeight.w700))),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 26),
            const Text('Dave', style: TextStyle(color: CupertinoColors.white, fontSize: 34, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text(widget.symbol.isEmpty ? 'is calling you…' : 'is calling about ${widget.symbol}…', style: const TextStyle(color: Color(0xB3FFFFFF), fontSize: 16)),
            const SizedBox(height: 22),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(color: const Color(0x1AFFFFFF), borderRadius: BorderRadius.circular(16)),
                child: Text(widget.reason, textAlign: TextAlign.center, maxLines: 5, overflow: TextOverflow.ellipsis, style: const TextStyle(color: CupertinoColors.white, fontSize: 15, height: 1.35)),
              ),
            ),
            const Spacer(),
            Padding(
              padding: const EdgeInsets.fromLTRB(44, 0, 44, 36),
              child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                _CallButton(key: const ValueKey('call-decline'), color: red, icon: CupertinoIcons.phone_down_fill, label: 'Decline', onTap: () => _finish('declined')),
                _CallButton(key: const ValueKey('call-answer'), color: green, icon: CupertinoIcons.phone_fill, label: 'Answer', onTap: _answer, bounce: _pulse),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _CallButton extends StatelessWidget {
  const _CallButton({super.key, required this.color, required this.icon, required this.label, required this.onTap, this.bounce});
  final Color color;
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final Animation<double>? bounce;

  @override
  Widget build(BuildContext context) {
    Widget circle = Container(
      width: 74,
      height: 74,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle, boxShadow: [BoxShadow(color: color.withValues(alpha: 0.5), blurRadius: 18)]),
      child: Icon(icon, color: CupertinoColors.white, size: 32),
    );
    if (bounce != null) {
      circle = AnimatedBuilder(
        animation: bounce!,
        builder: (_, child) => Transform.translate(offset: Offset(0, -6 * math.sin(bounce!.value * math.pi * 2).abs()), child: child),
        child: circle,
      );
    }
    return GestureDetector(
      onTap: onTap,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        circle,
        const SizedBox(height: 10),
        Text(label, style: const TextStyle(color: CupertinoColors.white, fontSize: 14, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

class _Rings extends CustomPainter {
  _Rings(this.t, this.color);
  final double t;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    for (var k = 0; k < 3; k++) {
      final p = (t + k / 3) % 1.0;
      final r = 58 + p * 52;
      canvas.drawCircle(c, r, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = color.withValues(alpha: (1 - p) * 0.55));
    }
  }

  @override
  bool shouldRepaint(_Rings old) => old.t != t || old.color != color;
}
