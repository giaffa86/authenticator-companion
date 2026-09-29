import sys, gi, collections
gi.require_version('Atspi','2.0')
from gi.repository import Atspi
Atspi.init()
app_sub=sys.argv[1] if len(sys.argv)>1 else None
desktop=Atspi.get_desktop(0)
c=collections.Counter()
def walk(node,d=0):
    if d>20: return
    try:
        c[node.get_role_name()]+=1; n=node.get_child_count()
    except Exception: return
    for i in range(n):
        try: walk(node.get_child_at_index(i),d+1)
        except Exception: pass
for i in range(desktop.get_child_count()):
    app=desktop.get_child_at_index(i)
    if app_sub and app_sub.lower() not in (app.get_name() or '').lower(): continue
    walk(app)
for k,v in c.most_common(): print(f"{v:4d}  {k}")
