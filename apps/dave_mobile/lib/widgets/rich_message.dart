import 'package:flutter/cupertino.dart';

import '../theme.dart';

/// Dave's messages as the app shows them: his markdown replies, Telegram-style HTML, and the
/// structured rich blocks (tables, headings, collapsible details...) his tools send -- the same
/// messages Telegram renders, so a table in Telegram is a table here too.

/// Telegram HTML (<b>, <i>, <code>, <pre>, <a>, <br>) -> the markdown [MarkdownText] reads.
String htmlToMarkdown(String html) {
  var s = html
      .replaceAll(RegExp(r'<br\s*/?>', caseSensitive: false), '\n')
      .replaceAllMapped(RegExp(r'<pre[^>]*>(?:<code[^>]*>)?([\s\S]*?)(?:</code>)?</pre>', caseSensitive: false), (m) => '\n```\n${m[1]}\n```\n')
      .replaceAllMapped(RegExp(r'</?(b|strong)>', caseSensitive: false), (_) => '**')
      .replaceAllMapped(RegExp(r'</?(i|em)>', caseSensitive: false), (_) => '_')
      .replaceAllMapped(RegExp(r'</?code>', caseSensitive: false), (_) => '`')
      .replaceAllMapped(RegExp(r'<blockquote[^>]*>([\s\S]*?)</blockquote>', caseSensitive: false), (m) => (m[1] ?? '').split('\n').map((l) => '> $l').join('\n'))
      .replaceAll(RegExp(r'<[^>]+>'), '');
  s = s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
  return s.trim();
}

/// Inline spans for one line: **bold**, __bold__, _italic_ / *italic*, `code`, [text](url).
List<InlineSpan> inlineSpans(BuildContext context, String text, TextStyle base) {
  final spans = <InlineSpan>[];
  final code = base.copyWith(fontFamily: 'Menlo', fontFamilyFallback: const ['Courier', 'monospace'], fontSize: (base.fontSize ?? 16) * 0.9, backgroundColor: resolve(context, CupertinoColors.tertiarySystemFill));
  final pattern = RegExp(r'\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?!\w)');
  var at = 0;
  for (final m in pattern.allMatches(text)) {
    if (m.start > at) spans.add(TextSpan(text: text.substring(at, m.start)));
    if (m[1] != null || m[2] != null) {
      spans.add(TextSpan(text: m[1] ?? m[2], style: const TextStyle(fontWeight: FontWeight.w600)));
    } else if (m[3] != null) {
      spans.add(TextSpan(text: m[3], style: code));
    } else if (m[4] != null) {
      spans.add(TextSpan(text: m[4], style: TextStyle(color: resolve(context, CupertinoColors.link))));
    } else {
      spans.add(TextSpan(text: m[6] ?? m[7], style: const TextStyle(fontStyle: FontStyle.italic)));
    }
    at = m.end;
  }
  if (at < text.length) spans.add(TextSpan(text: text.substring(at)));
  return spans;
}

/// Markdown the way models write it: headings, bullets, numbered lists, quotes, code fences,
/// pipe tables, and inline bold/italic/code.
class MarkdownText extends StatelessWidget {
  const MarkdownText(this.text, {super.key, this.color, this.fontSize = 16});
  final String text;
  final Color? color;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final base = TextStyle(fontSize: fontSize, height: 1.38, color: color ?? resolve(context, CupertinoColors.label), letterSpacing: -0.2);
    final lines = text.replaceAll('\r', '').split('\n');
    final out = <Widget>[];
    var paragraph = <String>[];

    void flush() {
      if (paragraph.isEmpty) return;
      out.add(Text.rich(TextSpan(style: base, children: inlineSpans(context, paragraph.join('\n'), base))));
      paragraph = [];
    }

    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      final t = line.trim();
      if (t.startsWith('```')) {
        flush();
        final code = <String>[];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          code.add(lines[i]);
          i++;
        }
        out.add(CodeBox(code.join('\n')));
        continue;
      }
      if (t.startsWith('|') && i + 1 < lines.length && RegExp(r'^\|?\s*:?-{2,}').hasMatch(lines[i + 1].trim())) {
        flush();
        final rows = <List<String>>[_cells(t)];
        i += 2;
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          rows.add(_cells(lines[i].trim()));
          i++;
        }
        i--;
        out.add(RichTable(rows));
        continue;
      }
      if (t.isEmpty) {
        flush();
        continue;
      }
      final heading = RegExp(r'^(#{1,6})\s+(.*)$').firstMatch(t);
      if (heading != null) {
        flush();
        final level = heading[1]!.length;
        final style = base.copyWith(fontSize: level == 1 ? fontSize + 5 : (level == 2 ? fontSize + 3 : fontSize + 1), fontWeight: FontWeight.w700, height: 1.25);
        out.add(Text.rich(TextSpan(style: style, children: inlineSpans(context, heading[2]!, style))));
        continue;
      }
      final bullet = RegExp(r'^([-*•]|\d+[.)])\s+(.*)$').firstMatch(t);
      if (bullet != null) {
        flush();
        final marker = RegExp(r'^\d').hasMatch(bullet[1]!) ? bullet[1]! : '•';
        final indent = (line.length - line.trimLeft().length) >= 2 ? 16.0 : 0.0;
        out.add(Padding(
          padding: EdgeInsets.only(left: indent),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 20, child: Text(marker, style: base.copyWith(color: resolve(context, CupertinoColors.secondaryLabel)))),
            Expanded(child: Text.rich(TextSpan(style: base, children: inlineSpans(context, bullet[2]!, base)))),
          ]),
        ));
        continue;
      }
      if (t.startsWith('>')) {
        flush();
        out.add(Quote(t.replaceFirst(RegExp(r'^>\s?'), '')));
        continue;
      }
      if (RegExp(r'^(-{3,}|\*{3,}|_{3,})$').hasMatch(t)) {
        flush();
        out.add(const Divider());
        continue;
      }
      paragraph.add(line);
    }
    flush();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (var i = 0; i < out.length; i++) Padding(padding: EdgeInsets.only(top: i == 0 ? 0 : 6), child: out[i]),
    ]);
  }

  static List<String> _cells(String row) {
    var r = row.trim();
    if (r.startsWith('|')) r = r.substring(1);
    if (r.endsWith('|')) r = r.substring(0, r.length - 1);
    return r.split('|').map((c) => c.trim()).toList();
  }
}

class Divider extends StatelessWidget {
  const Divider({super.key});
  @override
  Widget build(BuildContext context) => Container(height: 0.5, margin: const EdgeInsets.symmetric(vertical: 4), color: resolve(context, CupertinoColors.separator));
}

class Quote extends StatelessWidget {
  const Quote(this.text, {super.key, this.large = false});
  final String text;
  final bool large;
  @override
  Widget build(BuildContext context) {
    final style = TextStyle(fontSize: large ? 18 : 15, height: 1.35, fontStyle: large ? FontStyle.italic : null, color: resolve(context, CupertinoColors.secondaryLabel));
    return Container(
      padding: const EdgeInsets.only(left: 10),
      decoration: BoxDecoration(border: Border(left: BorderSide(color: resolve(context, CupertinoColors.systemBlue), width: 3))),
      child: Text.rich(TextSpan(style: style, children: inlineSpans(context, text, style))),
    );
  }
}

class CodeBox extends StatelessWidget {
  const CodeBox(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(Space.s3),
        decoration: BoxDecoration(color: resolve(context, CupertinoColors.tertiarySystemFill), borderRadius: BorderRadius.circular(10)),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Text(text, style: TextStyle(fontFamily: 'Menlo', fontFamilyFallback: const ['Courier', 'monospace'], fontSize: 13, height: 1.35, color: resolve(context, CupertinoColors.label))),
        ),
      );
}

/// A table whose first row is the header. Scrolls sideways when it's wider than the bubble.
class RichTable extends StatelessWidget {
  const RichTable(this.rows, {super.key});
  final List<List<String>> rows;

  @override
  Widget build(BuildContext context) {
    final nonEmpty = rows.where((r) => r.any((c) => c.trim().isNotEmpty)).toList();
    if (nonEmpty.isEmpty) return const SizedBox.shrink();
    final columns = nonEmpty.map((r) => r.length).reduce((a, b) => a > b ? a : b);
    final label = resolve(context, CupertinoColors.label);
    final line = resolve(context, CupertinoColors.separator);
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Container(
        decoration: BoxDecoration(border: Border.all(color: line, width: 0.5), borderRadius: BorderRadius.circular(10)),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Table(
            defaultColumnWidth: const IntrinsicColumnWidth(),
            border: TableBorder(horizontalInside: BorderSide(color: line, width: 0.5)),
            children: [
              for (var r = 0; r < nonEmpty.length; r++)
                TableRow(
                  decoration: r == 0 ? BoxDecoration(color: resolve(context, CupertinoColors.tertiarySystemFill)) : null,
                  children: [
                    for (var c = 0; c < columns; c++)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 220),
                          child: Builder(builder: (context) {
                            final style = TextStyle(fontSize: 14, height: 1.3, color: label, fontWeight: r == 0 ? FontWeight.w600 : FontWeight.w400);
                            return Text.rich(TextSpan(style: style, children: inlineSpans(context, c < nonEmpty[r].length ? nonEmpty[r][c] : '', style)));
                          }),
                        ),
                      ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Telegram's structured rich blocks.
class RichBlocks extends StatelessWidget {
  const RichBlocks(this.blocks, {super.key});
  final List<dynamic> blocks;

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    for (final raw in blocks) {
      if (raw is! Map) continue;
      final w = _block(context, Map<String, dynamic>.from(raw));
      if (w != null) children.add(w);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (var i = 0; i < children.length; i++) Padding(padding: EdgeInsets.only(top: i == 0 ? 0 : 8), child: children[i]),
    ]);
  }

  Widget? _block(BuildContext context, Map<String, dynamic> b) {
    final text = b['text'] is String ? b['text'] as String : '';
    final label = resolve(context, CupertinoColors.label);
    switch (b['type']) {
      case 'heading':
        final size = (b['size'] as num?)?.toInt() ?? 2;
        return Text(text, style: TextStyle(fontSize: size == 1 ? 21 : (size == 2 ? 18 : 16), fontWeight: FontWeight.w700, height: 1.25, color: label));
      case 'paragraph':
        return MarkdownText(text);
      case 'table':
        final cells = b['cells'];
        if (cells is! List) return null;
        return RichTable([for (final r in cells) if (r is List) r.map((c) => '$c').toList()]);
      case 'list':
        final items = b['items'];
        if (items is! List) return null;
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final item in items)
            if (item is Map && item['blocks'] is List)
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(width: 18, child: Text('•', style: TextStyle(fontSize: 16, color: resolve(context, CupertinoColors.secondaryLabel)))),
                Expanded(child: RichBlocks(item['blocks'] as List)),
              ]),
        ]);
      case 'pre':
        return CodeBox(text);
      case 'blockquote':
        return Quote(text);
      case 'pullquote':
        return Quote(text, large: true);
      case 'divider':
        return const Divider();
      case 'footer':
        return Text(text, style: TextStyle(fontSize: 12.5, height: 1.3, color: resolve(context, CupertinoColors.secondaryLabel)));
      case 'details':
        return Details(title: text, child: RichBlocks(b['blocks'] is List ? b['blocks'] as List : const []));
      case 'photo':
        final caption = b['caption'] is Map ? '${(b['caption'] as Map)['text'] ?? ''}' : '';
        final media = b['photo'] is Map ? '${(b['photo'] as Map)['media'] ?? ''}' : '';
        if (media.startsWith('http')) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.network(media, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox.shrink())),
            if (caption.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: MarkdownText(caption, fontSize: 14)),
          ]);
        }
        return caption.isEmpty ? null : MarkdownText(caption);
      default:
        return text.isEmpty ? null : MarkdownText(text);
    }
  }
}

/// Collapsed until tapped.
class Details extends StatefulWidget {
  const Details({super.key, required this.title, required this.child, this.initiallyOpen = false});
  final String title;
  final Widget child;
  final bool initiallyOpen;
  @override
  State<Details> createState() => _DetailsState();
}

class _DetailsState extends State<Details> {
  late bool _open = widget.initiallyOpen;
  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => setState(() => _open = !_open),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            AnimatedRotation(turns: _open ? 0.25 : 0, duration: const Duration(milliseconds: 150), child: Icon(CupertinoIcons.chevron_right, size: 13, color: secondary)),
            const SizedBox(width: 6),
            Expanded(child: Text(widget.title, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: secondary))),
          ]),
        ),
      ),
      if (_open) Padding(padding: const EdgeInsets.only(left: 19, top: 4), child: widget.child),
    ]);
  }
}

/// One button from a card's inline keyboard.
class CardButton {
  CardButton(this.text, this.callback, {this.style});
  final String text;
  final String? callback;

  /// green / red / blue, when the card colours its buttons.
  final String? style;
}

/// A Telegram inline keyboard -> rows of buttons.
List<List<CardButton>> parseButtons(Object? markup) {
  if (markup is! Map || markup['inline_keyboard'] is! List) return const [];
  final rows = <List<CardButton>>[];
  for (final row in markup['inline_keyboard'] as List) {
    if (row is! List) continue;
    final buttons = [
      for (final b in row)
        if (b is Map && b['text'] is String && b['callback_data'] is String) CardButton(b['text'] as String, b['callback_data'] as String, style: b['style'] as String?),
    ];
    if (buttons.isNotEmpty) rows.add(buttons);
  }
  return rows;
}

class CardButtons extends StatelessWidget {
  const CardButtons({super.key, required this.rows, required this.onTap, this.used});
  final List<List<CardButton>> rows;
  final Future<void> Function(CardButton button) onTap;

  /// Set once a button was tapped, so a card isn't answered twice.
  final String? used;

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      for (final row in rows)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Row(children: [
            for (var i = 0; i < row.length; i++) ...[
              if (i > 0) const SizedBox(width: 6),
              Expanded(child: _button(context, row[i])),
            ],
          ]),
        ),
    ]);
  }

  Widget _button(BuildContext context, CardButton b) {
    final tint = switch (b.style) {
      'green' || 'success' => CupertinoColors.systemGreen,
      'red' || 'danger' => CupertinoColors.systemRed,
      _ => CupertinoColors.systemBlue,
    };
    final color = resolve(context, tint);
    final chosen = used == b.callback;
    return CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
      minimumSize: const Size(0, 38),
      color: chosen ? color : color.withValues(alpha: 0.13),
      borderRadius: BorderRadius.circular(12),
      onPressed: used != null ? null : () => onTap(b),
      child: Text(b.text, maxLines: 2, textAlign: TextAlign.center, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: chosen ? CupertinoColors.white : color)),
    );
  }
}
