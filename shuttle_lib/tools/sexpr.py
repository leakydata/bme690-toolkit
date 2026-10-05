"""Minimal reader and writer for KiCad S-expression files.

A node is a Python list whose first element is the keyword (a Sym) and whose
other elements are nodes, Sym atoms, numbers or strings. Strings are written
back quoted, Sym atoms bare.
"""

import re


class Sym(str):
    """A bare (unquoted) atom such as a keyword, yes/no or a layer name."""


_TOKEN = re.compile(r'\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))', re.S)


def _unescape(raw):
    out = []
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == "\\" and i + 1 < len(raw):
            nxt = raw[i + 1]
            out.append("\n" if nxt == "n" else nxt)
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def parse(text):
    """Parse the first complete expression in text."""
    stack = [[]]
    pos = 0
    end = len(text)
    while pos < end:
        m = _TOKEN.match(text, pos)
        if not m:
            if text[pos:].strip() == "":
                break
            raise ValueError("cannot parse near offset %d" % pos)
        pos = m.end()
        if m.group(1):
            stack.append([])
        elif m.group(2):
            node = stack.pop()
            stack[-1].append(node)
            if len(stack) == 1:
                return stack[0][0]
        elif m.group(3) is not None:
            raw = m.group(3)
            stack[-1].append(_unescape(raw))
        else:
            atom = m.group(4)
            try:
                if re.fullmatch(r"-?\d+", atom):
                    value = int(atom)
                else:
                    value = float(atom)
                stack[-1].append(value)
            except ValueError:
                stack[-1].append(Sym(atom))
    raise ValueError("unbalanced expression")


def _atom(value):
    if isinstance(value, Sym):
        return str(value)
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        text = ("%.6f" % value).rstrip("0").rstrip(".")
        if text in ("-0", ""):
            text = "0"
        return text
    text = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return '"' + text + '"'


def dump(node, indent=0):
    """Serialise a node with one child list per line, KiCad style."""
    if not isinstance(node, list):
        return _atom(node)
    pad = "\t" * indent
    head = []
    tail = []
    for item in node:
        if isinstance(item, list) and _is_big(item):
            tail.append(item)
        elif tail:
            tail.append(item)
        else:
            head.append(item)
    line = pad + "(" + " ".join(dump(h) if isinstance(h, list) else _atom(h) for h in head)
    if not tail:
        return line + ")"
    parts = [line]
    for item in tail:
        if isinstance(item, list):
            parts.append(dump(item, indent + 1))
        else:
            parts.append("\t" * (indent + 1) + _atom(item))
    parts.append(pad + ")")
    return "\n".join(parts)


def _is_big(node):
    """Lists that hold other lists go on their own lines."""
    return any(isinstance(x, list) for x in node[1:]) or len(node) > 6


def find(node, key):
    """First child list whose keyword is key, or None."""
    for item in node:
        if isinstance(item, list) and item and item[0] == key:
            return item
    return None


def find_all(node, key):
    return [item for item in node if isinstance(item, list) and item and item[0] == key]


def S(*items):
    """Build a node; the first item becomes a Sym keyword."""
    out = [Sym(items[0])]
    out.extend(items[1:])
    return out
