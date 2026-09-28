import 'dart:math' as math;

import 'package:flutter/cupertino.dart';

/// Dave's drawing board in the app: the same picture the bot sends to Telegram as an image
/// (dave-agent-loop/src/setup-drawing.ts), drawn natively -- small candles (projected ones hollow
/// and dashed), entry/SL/TP lines, zones, arrows and notes.
class SetupDrawingView extends StatelessWidget {
  const SetupDrawingView({super.key, required this.drawing, this.caption});
  final Map<String, dynamic> drawing;
  final String? caption;

  @override
  Widget build(BuildContext context) {
    final title = '${drawing['title'] ?? 'Setup'}';
    final sub = [drawing['symbol'], drawing['timeframe']].where((x) => x != null && '$x'.isNotEmpty).join(' · ');
    final note = drawing['caption'] as String?;
    return Container(
      decoration: BoxDecoration(color: const Color(0xFF0B0D0E), borderRadius: BorderRadius.circular(18)),
      padding: const EdgeInsets.fromLTRB(12, 12, 8, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          Expanded(child: Text(title, style: const TextStyle(color: Color(0xFFF2F4EF), fontSize: 15, fontWeight: FontWeight.w700))),
          if (sub.isNotEmpty) Text(sub, style: const TextStyle(color: Color(0xFF8E959A), fontSize: 12)),
          GestureDetector(
            key: const ValueKey('drawing-open'),
            onTap: () => Navigator.of(context).push(CupertinoPageRoute<void>(fullscreenDialog: true, builder: (_) => DrawingViewer(drawing: drawing))),
            child: const Padding(padding: EdgeInsets.only(left: 10, right: 4), child: Icon(CupertinoIcons.rotate_right, size: 19, color: Color(0xFFC6F36B))),
          ),
        ]),
        const SizedBox(height: 8),
        AspectRatio(aspectRatio: 1.45, child: CustomPaint(painter: _DrawingPainter(drawing, DefaultTextStyle.of(context).style.fontFamily), size: Size.infinite)),
        if (note != null && note.isNotEmpty)
          Padding(padding: const EdgeInsets.only(top: 6, right: 4), child: Text(note, style: const TextStyle(color: Color(0xFF8E959A), fontSize: 12.5, height: 1.3))),
      ]),
    );
  }
}

/// Full screen, pinch to zoom, and a button that turns the picture a quarter at a time -- on a
/// phone held upright a wide chart reads far better turned sideways.
class DrawingViewer extends StatefulWidget {
  const DrawingViewer({super.key, required this.drawing});
  final Map<String, dynamic> drawing;

  @override
  State<DrawingViewer> createState() => _DrawingViewerState();
}

class _DrawingViewerState extends State<DrawingViewer> {
  int _turns = 1; // opens sideways: that's why you tapped it

  @override
  Widget build(BuildContext context) {
    final font = DefaultTextStyle.of(context).style.fontFamily;
    return CupertinoPageScaffold(
      backgroundColor: _bg,
      navigationBar: CupertinoNavigationBar(
        backgroundColor: _bg,
        middle: Text('${widget.drawing['title'] ?? 'Setup'}', style: const TextStyle(color: _text)),
        leading: CupertinoButton(padding: EdgeInsets.zero, onPressed: () => Navigator.pop(context), child: const Icon(CupertinoIcons.xmark, color: _text)),
        trailing: CupertinoButton(
          key: const ValueKey('drawing-rotate'),
          padding: EdgeInsets.zero,
          onPressed: () => setState(() => _turns = (_turns + 1) % 4),
          child: const Icon(CupertinoIcons.rotate_right, color: Color(0xFFC6F36B)),
        ),
      ),
      child: SafeArea(
        child: InteractiveViewer(
          maxScale: 5,
          child: Center(
            child: RotatedBox(
              quarterTurns: _turns,
              child: AspectRatio(aspectRatio: 1.45, child: CustomPaint(painter: _DrawingPainter(widget.drawing, font), size: Size.infinite)),
            ),
          ),
        ),
      ),
    );
  }
}

const _up = Color(0xFF8BF06B);
const _down = Color(0xFFFF6B6B);
const _text = Color(0xFFF2F4EF);
const _muted = Color(0xFF8E959A);
const _grid = Color(0xFF1C2023);
const _bg = Color(0xFF0B0D0E);
const _kinds = {
  'entry': Color(0xFFC6F36B),
  'sl': Color(0xFFFF6B6B),
  'tp': Color(0xFF5BD6A0),
  'level': Color(0xFF9AA3A8),
  'demand': Color(0xFF5BD6A0),
  'supply': Color(0xFFFF6B6B),
  'fvg': Color(0xFFB28CFF),
  'ob': Color(0xFF5AA9FF),
  'range': Color(0xFF9AA3A8),
};

double? _n(Object? v) => v is num ? v.toDouble() : (v is String ? double.tryParse(v) : null);
List<Map<String, dynamic>> _l(Object? v) => v is List ? v.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList() : const [];

class _DrawingPainter extends CustomPainter {
  _DrawingPainter(this.d, this.fontFamily);
  final Map<String, dynamic> d;
  final String? fontFamily;

  String _fmt(double p, double span) {
    final dec = span >= 100 ? 0 : (span >= 1 ? 2 : (span >= 0.01 ? 4 : 5));
    return p.toStringAsFixed(dec);
  }

  void _label(Canvas c, String t, Offset at, {Color color = _text, double size = 11, FontWeight weight = FontWeight.w400, Color? bg, bool alignRight = false}) {
    final tp = TextPainter(text: TextSpan(text: t, style: TextStyle(color: color, fontSize: size, fontWeight: weight, fontFamily: fontFamily)), textDirection: TextDirection.ltr, maxLines: 1, ellipsis: '…')
      ..layout(maxWidth: 220);
    var o = alignRight ? at - Offset(tp.width, 0) : at;
    if (bg != null) {
      final r = RRect.fromRectAndRadius(Rect.fromLTWH(o.dx - 5, o.dy - 2, tp.width + 10, tp.height + 4), const Radius.circular(5));
      c.drawRRect(r, Paint()..color = bg);
    }
    tp.paint(c, o);
  }

  void _dashed(Canvas c, Offset a, Offset b, Paint p, {double dash = 6, double gap = 4}) {
    final len = (b - a).distance;
    if (len == 0) return;
    final dir = (b - a) / len;
    for (var s = 0.0; s < len; s += dash + gap) {
      c.drawLine(a + dir * s, a + dir * math.min(s + dash, len), p);
    }
  }

  @override
  void paint(Canvas canvas, Size size) {
    final candles = _l(d['candles']);
    if (candles.isEmpty) return;
    final lines = _l(d['lines']);
    final zones = _l(d['zones']);
    final arrows = _l(d['arrows']);
    final notes = _l(d['notes']);
    final prices = <double>[
      for (final c in candles) ...[_n(c['h']) ?? 0, _n(c['l']) ?? 0],
      for (final x in lines) _n(x['price']) ?? 0,
      for (final z in zones) ...[_n(z['from']) ?? 0, _n(z['to']) ?? 0],
      for (final a in arrows) ...[_n(a['fromPrice']) ?? 0, _n(a['toPrice']) ?? 0],
      for (final x in notes) _n(x['price']) ?? 0,
    ].where((p) => p != 0).toList();
    if (prices.isEmpty) return;
    var lo = prices.reduce(math.min);
    var hi = prices.reduce(math.max);
    if (hi == lo) {
      hi += 1;
      lo -= 1;
    }
    final span = hi - lo;
    hi += span * 0.08;
    lo -= span * 0.08;
    var idxMax = candles.length - 1.0;
    for (final a in arrows) {
      idxMax = math.max(idxMax, math.max(_n(a['fromIndex']) ?? 0, _n(a['toIndex']) ?? 0));
    }
    for (final x in notes) {
      idxMax = math.max(idxMax, _n(x['index']) ?? 0);
    }
    final slots = math.max(idxMax + 2, candles.length + 1.0);
    const right = 64.0;
    final plotW = size.width - right;
    final slotW = plotW / slots;
    double x(double i) => slotW * (i + 0.5);
    double y(double p) => 6 + (hi - p) / (hi - lo) * (size.height - 12);

    // grid + axis
    final gridPaint = Paint()
      ..color = _grid
      ..strokeWidth = 1;
    for (var k = 0; k <= 4; k++) {
      final p = lo + (hi - lo) * k / 4;
      canvas.drawLine(Offset(0, y(p)), Offset(plotW, y(p)), gridPaint);
      _label(canvas, _fmt(p, span), Offset(size.width - 2, y(p) - 7), color: _muted, size: 9.5, alignRight: true);
    }
    // zones
    for (final z in zones) {
      final col = _kinds['${z['kind']}'] ?? _kinds['range']!;
      final fi = _n(z['fromIndex']);
      final ti = _n(z['toIndex']);
      final r = Rect.fromLTRB(fi == null ? 0 : x(fi) - slotW / 2, y(_n(z['to'])!), ti == null ? plotW : x(ti) + slotW / 2, y(_n(z['from'])!));
      canvas.drawRect(r, Paint()..color = col.withValues(alpha: 0.14));
      canvas.drawRect(r, Paint()
        ..color = col.withValues(alpha: 0.5)
        ..style = PaintingStyle.stroke);
      if (z['label'] != null) _label(canvas, '${z['label']}', r.topLeft + const Offset(5, 3), color: col, size: 10, weight: FontWeight.w700);
    }
    // candles
    final bodyW = (slotW * 0.62).clamp(2.0, 16.0);
    for (var i = 0; i < candles.length; i++) {
      final c = candles[i];
      final o = _n(c['o'])!, h = _n(c['h'])!, l = _n(c['l'])!, cl = _n(c['c'])!;
      final col = cl >= o ? _up : _down;
      final projected = c['projected'] == true;
      final wick = Paint()
        ..color = projected ? col.withValues(alpha: 0.7) : col
        ..strokeWidth = 1.4;
      final cx = x(i.toDouble());
      if (projected) {
        _dashed(canvas, Offset(cx, y(h)), Offset(cx, y(l)), wick, dash: 3, gap: 2);
      } else {
        canvas.drawLine(Offset(cx, y(h)), Offset(cx, y(l)), wick);
      }
      final body = Rect.fromLTWH(cx - bodyW / 2, y(math.max(o, cl)), bodyW, math.max((y(o) - y(cl)).abs(), 1.5));
      if (projected) {
        final p = Paint()
          ..color = col
          ..strokeWidth = 1.3;
        _dashed(canvas, body.topLeft, body.topRight, p, dash: 3, gap: 2);
        _dashed(canvas, body.bottomLeft, body.bottomRight, p, dash: 3, gap: 2);
        _dashed(canvas, body.topLeft, body.bottomLeft, p, dash: 3, gap: 2);
        _dashed(canvas, body.topRight, body.bottomRight, p, dash: 3, gap: 2);
      } else {
        canvas.drawRRect(RRect.fromRectAndRadius(body, const Radius.circular(1.5)), Paint()..color = col);
      }
    }
    // lines
    for (final ln in lines) {
      final kind = '${ln['kind'] ?? 'level'}';
      final col = _kinds[kind] ?? _kinds['level']!;
      final yy = y(_n(ln['price'])!);
      _dashed(canvas, Offset(0, yy), Offset(plotW, yy), Paint()
        ..color = col
        ..strokeWidth = 1.5, dash: kind == 'level' ? 3 : 7, gap: kind == 'level' ? 4 : 4);
      _label(canvas, '${ln['label'] ?? kind.toUpperCase()} ${_fmt(_n(ln['price'])!, span)}', Offset(size.width - 2, yy - 7),
          color: _bg, size: 9.5, weight: FontWeight.w700, bg: col, alignRight: true);
    }
    // arrows
    for (final a in arrows) {
      final p0 = Offset(x(_n(a['fromIndex'])!), y(_n(a['fromPrice'])!));
      final p1 = Offset(x(_n(a['toIndex'])!), y(_n(a['toPrice'])!));
      final ctrl = Offset((p0.dx + p1.dx) / 2, math.min(p0.dy, p1.dy) - (p1.dx - p0.dx).abs() * 0.12);
      final path = Path()
        ..moveTo(p0.dx, p0.dy)
        ..quadraticBezierTo(ctrl.dx, ctrl.dy, p1.dx, p1.dy);
      canvas.drawPath(path, Paint()
        ..color = _text
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2);
      final ang = math.atan2(p1.dy - ctrl.dy, p1.dx - ctrl.dx);
      final head = Path()
        ..moveTo(p1.dx, p1.dy)
        ..lineTo(p1.dx - 9 * math.cos(ang - 0.45), p1.dy - 9 * math.sin(ang - 0.45))
        ..lineTo(p1.dx - 9 * math.cos(ang + 0.45), p1.dy - 9 * math.sin(ang + 0.45))
        ..close();
      canvas.drawPath(head, Paint()..color = _text);
      if (a['label'] != null) _label(canvas, '${a['label']}', ctrl - const Offset(20, 16), size: 10.5);
    }
    // notes
    for (final nt in notes) {
      final at = Offset(x(_n(nt['index'])!), y(_n(nt['price'])!));
      canvas.drawCircle(at, 3, Paint()..color = _text);
      _label(canvas, '${nt['text']}', at - const Offset(18, 22), size: 10, bg: const Color(0xFF1E2326));
    }
  }

  @override
  bool shouldRepaint(_DrawingPainter old) => old.d != d;
}
