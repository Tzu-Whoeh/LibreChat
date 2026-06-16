#!/usr/bin/env python3
"""Content-agnostic python-pptx renderer for the pptx MCP server.

Reads a single JSON job from stdin and prints a single JSON result to stdout.
Never prints anything else to stdout (the Node parent parses stdout as JSON);
diagnostics go to stderr.

Jobs:
  {"action": "render", "spec": {...}, "templatePath": str|None, "outPath": str}
      -> {"path": str, "slides": int}  on success
  {"action": "inspect", "templatePath": str}
      -> {"layouts": [{"index": int, "name": str}]}
  {"action": "merge", "inputs": [str, ...], "outPath": str}
      -> {"path": str, "slides": int}  appends slides of inputs[1:] onto inputs[0]
  any failure -> {"error": str}

The renderer maps a small, stable layout vocabulary onto whatever layouts the
chosen base presentation provides (default template, or an uploaded one). It
degrades gracefully: if a named layout is missing it falls back to a sensible
index, so an arbitrary uploaded template still works.
"""

import json
import sys
import os


def _emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def _fail(msg):
    _emit({"error": str(msg)})
    sys.exit(0)


def _load_pptx():
    try:
        from pptx import Presentation  # noqa: F401
        from pptx.util import Pt, Emu  # noqa: F401
        from pptx.dml.color import RGBColor  # noqa: F401
        return sys.modules["pptx"]
    except Exception as e:  # pragma: no cover - import guard
        _fail(f"python-pptx not available: {e}")


# Map our stable layout names to typical python-pptx default-template indices.
# These are best-effort; _pick_layout falls back if an index is out of range.
_LAYOUT_HINTS = {
    "title": 0,          # Title Slide
    "title_content": 1,  # Title and Content
    "section": 2,        # Section Header
    "blank": 6,          # Blank
}


def _pick_layout(prs, name):
    layouts = prs.slide_layouts
    n = len(layouts)
    if n == 0:
        raise ValueError("template has no slide layouts")
    # 1) try to match by layout name (case-insensitive contains)
    wanted = (name or "title_content").lower()
    name_keywords = {
        "title": ["title slide", "title"],
        "title_content": ["title and content", "content"],
        "section": ["section"],
        "blank": ["blank"],
    }.get(wanted, [])
    for kw in name_keywords:
        for layout in layouts:
            try:
                if kw in (layout.name or "").lower():
                    return layout
            except Exception:
                pass
    # 2) fall back to the hinted index, clamped to range
    idx = _LAYOUT_HINTS.get(wanted, 1)
    if idx >= n:
        idx = min(1, n - 1)
    return layouts[idx]


def _set_font(run, font_name=None, size_pt=None, color_hex=None):
    from pptx.util import Pt
    from pptx.dml.color import RGBColor
    if font_name:
        run.font.name = font_name
    if size_pt:
        run.font.size = Pt(size_pt)
    if color_hex:
        try:
            run.font.color.rgb = RGBColor.from_string(color_hex.lstrip("#"))
        except Exception:
            pass


def _norm_bullets(bullets):
    out = []
    for b in bullets or []:
        if isinstance(b, str):
            out.append({"text": b, "level": 0})
        elif isinstance(b, dict) and "text" in b:
            out.append({"text": str(b["text"]), "level": int(b.get("level", 0) or 0)})
    return out


def _add_title(slide, text, theme):
    if not text:
        return
    title_ph = None
    try:
        title_ph = slide.shapes.title
    except Exception:
        title_ph = None
    if title_ph is not None:
        title_ph.text = text
        try:
            run = title_ph.text_frame.paragraphs[0].runs[0]
            _set_font(run, theme.get("titleFont"), None, theme.get("accentColor"))
        except Exception:
            pass


def _body_placeholder(slide):
    # Prefer an explicit body/content placeholder; else first non-title placeholder.
    from pptx.util import Pt  # noqa: F401
    title_id = None
    try:
        if slide.shapes.title is not None:
            title_id = slide.shapes.title.placeholder_format.idx
    except Exception:
        title_id = None
    candidate = None
    for ph in slide.placeholders:
        try:
            if ph.placeholder_format.idx == title_id:
                continue
        except Exception:
            pass
        candidate = ph
        break
    return candidate


def _add_bullets(slide, bullets, theme):
    bullets = _norm_bullets(bullets)
    if not bullets:
        return
    body = _body_placeholder(slide)
    if body is None or not body.has_text_frame:
        return
    tf = body.text_frame
    tf.clear()
    for i, b in enumerate(bullets):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = b["text"]
        p.level = max(0, min(4, b["level"]))
        try:
            _set_font(p.runs[0], theme.get("bodyFont"), None, None)
        except Exception:
            pass


def _add_subtitle(slide, text):
    if not text:
        return
    for ph in slide.placeholders:
        try:
            name = (ph.name or "").lower()
        except Exception:
            name = ""
        if "subtitle" in name and ph.has_text_frame:
            ph.text = text
            return
    # fallback: use the body placeholder if no explicit subtitle
    body = _body_placeholder(slide)
    if body is not None and body.has_text_frame:
        body.text = text


def _add_image(slide, image_path):
    from pptx.util import Inches
    if not image_path or not os.path.exists(image_path):
        return
    try:
        slide.shapes.add_picture(image_path, Inches(1), Inches(1.8), height=Inches(4))
    except Exception:
        pass


def _add_notes(slide, notes):
    if not notes:
        return
    try:
        slide.notes_slide.notes_text_frame.text = notes
    except Exception:
        pass


def _apply_background(slide, theme):
    color = theme.get("backgroundColor")
    if not color:
        return
    from pptx.dml.color import RGBColor
    try:
        fill = slide.background.fill
        fill.solid()
        fill.fore_color.rgb = RGBColor.from_string(color.lstrip("#"))
    except Exception:
        pass


def action_render(job):
    pptx = _load_pptx()
    from pptx import Presentation

    spec = job.get("spec") or {}
    template_path = job.get("templatePath")
    out_path = job.get("outPath")
    if not out_path:
        raise ValueError("outPath is required")

    if template_path:
        if not os.path.exists(template_path):
            raise ValueError(f"templatePath does not exist: {template_path}")
        prs = Presentation(template_path)
        # Remove any slides that ship inside the template so we start clean,
        # while keeping its masters/layouts/theme.
        xml_slides = prs.slides._sldIdLst
        for sldId in list(xml_slides):
            xml_slides.remove(sldId)
    else:
        prs = Presentation()

    theme = (spec.get("theme") or {}) if not template_path else {}

    slides_spec = spec.get("slides") or []
    # Optional dedicated title slide if a deck title is provided and the first
    # slide isn't already a title layout. Set spec.titleSlide=false to suppress
    # it (used when rendering a fragment that will be merged into a larger deck).
    title = spec.get("title")
    subtitle = spec.get("subtitle")
    want_title_slide = spec.get("titleSlide", True)
    count = 0

    if want_title_slide and title and (not slides_spec or slides_spec[0].get("layout") != "title"):
        layout = _pick_layout(prs, "title")
        slide = prs.slides.add_slide(layout)
        _apply_background(slide, theme)
        _add_title(slide, title, theme)
        _add_subtitle(slide, subtitle or "")
        count += 1

    for s in slides_spec:
        layout = _pick_layout(prs, s.get("layout") or "title_content")
        slide = prs.slides.add_slide(layout)
        _apply_background(slide, theme)
        _add_title(slide, s.get("title"), theme)
        if s.get("subtitle"):
            _add_subtitle(slide, s.get("subtitle"))
        _add_bullets(slide, s.get("bullets"), theme)
        _add_image(slide, s.get("imagePath"))
        _add_notes(slide, s.get("notes"))
        count += 1

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    prs.save(out_path)
    return {"path": out_path, "slides": count}


def action_inspect(job):
    _load_pptx()
    from pptx import Presentation
    template_path = job.get("templatePath")
    if not template_path or not os.path.exists(template_path):
        raise ValueError(f"templatePath does not exist: {template_path}")
    prs = Presentation(template_path)
    layouts = []
    for i, layout in enumerate(prs.slide_layouts):
        try:
            layouts.append({"index": i, "name": layout.name})
        except Exception:
            layouts.append({"index": i, "name": f"layout {i}"})
    return {"layouts": layouts}


def _copy_slide_into(dest_prs, src_slide):
    """Deep-copy one slide (XML + its part relationships) from a source
    presentation into dest_prs. python-pptx has no public 'copy slide' API,
    so we clone the slide part's element and re-attach external relationships
    (images, media) by copying the referenced parts and rewriting r:embed/r:id.

    This avoids the duplicate-slideN.xml / dropped-slide corruption that occurs
    when naively reusing a finished deck as a template.
    """
    import copy
    from pptx.oxml.ns import qn
    from pptx.opc.package import Part
    from pptx.opc.packuri import PackURI

    # Use the first available layout in the destination as the new slide's layout.
    dest_layout = dest_prs.slide_layouts[0]
    new_slide = dest_prs.slides.add_slide(dest_layout)

    # Remove every shape the blank layout seeded, so we start from an empty slide
    # and bring over exactly the source slide's shape tree.
    spTree = new_slide.shapes._spTree
    for shape in list(new_slide.shapes):
        spTree.remove(shape._element)

    # Deep-copy each top-level shape element from the source slide.
    src_part = src_slide.part
    dest_part = new_slide.part
    # Map old rId -> new rId for any relationships referenced by the copied shapes.
    rId_map = {}

    def _clone_related_part(old_rId):
        if old_rId in rId_map:
            return rId_map[old_rId]
        rel = src_part.rels[old_rId]
        if rel.is_external:
            new_rId = dest_part.rels.get_or_add_ext_rel(rel.reltype, rel.target_ref)
        else:
            src_target = rel.target_part
            # copy the binary part (e.g. image) into the dest package, letting
            # next_partname fill the numbering into a '%d' template. Preserve the
            # source extension so content-type detection stays correct.
            src_name = str(src_target.partname)
            ext = src_name.rsplit(".", 1)[-1] if "." in src_name else "bin"
            partname = dest_part.package.next_partname("/ppt/media/image%d." + ext)
            new_part = Part(partname, src_target.content_type, dest_part.package, src_target.blob)
            new_rId = dest_part.relate_to(new_part, rel.reltype)
        rId_map[old_rId] = new_rId
        return new_rId

    for shp in src_slide.shapes._spTree.iterchildren():
        tag = shp.tag
        # skip the non-shape children that the spTree starts with
        if tag.endswith("}nvGrpSpPr") or tag.endswith("}grpSpPr"):
            continue
        cloned = copy.deepcopy(shp)
        # rewrite any r:embed / r:link / r:id attributes to remapped rIds
        for el in cloned.iter():
            for attr in (qn("r:embed"), qn("r:link"), qn("r:id")):
                val = el.get(attr)
                if val and val in src_part.rels:
                    el.set(attr, _clone_related_part(val))
        spTree.append(cloned)

    # Bring over speaker notes if present.
    try:
        if src_slide.has_notes_slide and src_slide.notes_slide.notes_text_frame.text:
            new_slide.notes_slide.notes_text_frame.text = (
                src_slide.notes_slide.notes_text_frame.text
            )
    except Exception:
        pass


def action_merge(job):
    """Merge several .pptx files (in order) into one deck.

    Job: {"action":"merge", "inputs":[path, ...], "outPath": path}
    The first input seeds the base (preserving its theme/size); subsequent
    inputs' slides are appended in order. Returns {"path", "slides"}.
    """
    _load_pptx()
    from pptx import Presentation

    inputs = job.get("inputs") or []
    out_path = job.get("outPath")
    if not isinstance(inputs, list) or len(inputs) < 1:
        raise ValueError("inputs must be a non-empty list of .pptx paths")
    if not out_path:
        raise ValueError("outPath is required")
    for p in inputs:
        if not p or not os.path.exists(p):
            raise ValueError(f"input does not exist: {p}")

    # Seed from the first deck so slide size + theme carry over.
    base = Presentation(inputs[0])
    for extra_path in inputs[1:]:
        src = Presentation(extra_path)
        for slide in src.slides:
            _copy_slide_into(base, slide)

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    base.save(out_path)
    total = len(base.slides._sldIdLst)
    return {"path": out_path, "slides": total}


def main():
    raw = sys.stdin.read()
    try:
        job = json.loads(raw)
    except Exception as e:
        _fail(f"invalid job JSON: {e}")
        return
    action = job.get("action")
    try:
        if action == "render":
            _emit(action_render(job))
        elif action == "inspect":
            _emit(action_inspect(job))
        elif action == "merge":
            _emit(action_merge(job))
        else:
            _fail(f"unknown action: {action}")
    except Exception as e:
        _fail(e)


if __name__ == "__main__":
    main()
