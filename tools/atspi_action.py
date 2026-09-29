import sys, gi
gi.require_version('Atspi','2.0')
from gi.repository import Atspi
Atspi.init()
# usage: atspi_action.py <app-substr> <action-name>
app_sub, action = sys.argv[1], sys.argv[2]
desktop = Atspi.get_desktop(0)

def walk(node, depth=0):
    if depth > 16: return None
    try:
        act = node.get_action_iface(); n = node.get_child_count()
    except Exception:
        return None
    if act:
        names = []
        for i in range(act.get_n_actions()):
            try: names.append(act.get_action_name(i))
            except Exception: names.append('')
        if action in names:
            return (node, act, names.index(action))
    for i in range(n):
        try:
            r = walk(node.get_child_at_index(i), depth+1)
            if r: return r
        except Exception: pass
    return None

for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app_sub.lower() not in (app.get_name() or '').lower(): continue
    r = walk(app)
    if r:
        node, act, idx = r
        print(f"found '{action}' -> node=[{node.get_role_name()}] {node.get_name()!r} idx={idx}")
        ok = act.do_action(idx)
        print("do_action result:", ok)
    else:
        print("action not found")
