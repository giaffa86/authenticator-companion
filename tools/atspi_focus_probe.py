import gi, time
gi.require_version('Atspi','2.0')
from gi.repository import Atspi, GLib
Atspi.init()
events=[]
def on_event(e):
    try:
        src=e.source
        events.append((e.type, src.get_role_name(), src.get_name()))
    except Exception as ex:
        events.append(("err",str(ex),""))
Atspi.EventListener.register_from_callback(on_event, None, "object:state-changed:focused")
Atspi.EventListener.register_from_callback(on_event, None, "object:state-changed:active")
time.sleep(1)
# ensure preferences dialog present
import subprocess
subprocess.run(["gdbus","call","--session","--dest","com.belmoussaoui.Authenticator","--object-path","/com/belmoussaoui/Authenticator","--method","org.gtk.Actions.Activate","preferences","[]","{}"],capture_output=True)
time.sleep(3)
def key(sym, code):
    Atspi.generate_keyboard_event(code, sym, Atspi.KeySynthType.PRESSRELEASE)
print("--- pressing Tab x8 ---")
for i in range(8):
    key("Tab", 0xff09)
    time.sleep(0.6)
print("--- typing testpass123 ---")
for ch in "testpass123":
    key(ch, 0)
    time.sleep(0.15)
time.sleep(1)
print("EVENTS:")
seen=set()
for t,r,n in events:
    k=(t,r,n)
    if k in seen: continue
    seen.add(k)
    print(" ", t, "|", r, "|", repr(n))
