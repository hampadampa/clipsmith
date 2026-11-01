from clipsmith.pipeline.units import Word, build_units


def words_from(spec):
    """spec: list of (text, start, end)"""
    return [Word(t, s, e) for t, s, e in spec]


def sentence(text, start, wps=3.0):
    """Evenly spaced words for `text` starting at `start`; returns (words, end)."""
    out, t = [], start
    for tok in text.split():
        out.append(Word(tok, t, t + 1 / wps * 0.9))
        t += 1 / wps
    return out, t
