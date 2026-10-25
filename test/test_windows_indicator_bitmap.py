import importlib.util
from pathlib import Path
import threading
import sys
import types
import unittest
spec=importlib.util.spec_from_file_location('patcher',Path(__file__).parents[1]/'scripts/patch-windows-indicator.py')
patcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(patcher)

HEALTH_CHECK = '''def is_healthy() -> bool:
    with _lock:
        indicator = _instance
    return bool(
        indicator
        and indicator.thread.is_alive()
        and not indicator.stopping
        and indicator.error is None
        and 0 <= time.monotonic() - indicator.heartbeat <= 1.0
    )


@contextmanager
def unused():pass
'''

class IndicatorBitmapTests(unittest.TestCase):
 def setUp(self):
  self.calls=[];self.fail_bitmap=False;self.fail_upload=False
  def call(name,result=True):
   def invoke(*args):self.calls.append((name,args));return result
   return invoke
  def dib(*args):
   self.calls.append(('create_bitmap',args))
   if self.fail_bitmap:return 0
   args[3].value=99;return 12
  self.api=types.SimpleNamespace(
   _user32=types.SimpleNamespace(GetDC=call('get_dc',10),ReleaseDC=call('release_dc'),UpdateLayeredWindow=lambda *args:(self.calls.append(('upload',args)) or not self.fail_upload)),
   _gdi32=types.SimpleNamespace(CreateCompatibleDC=call('create_dc',11),CreateDIBSection=dib,SelectObject=call('select',13),DeleteObject=call('delete_bitmap'),DeleteDC=call('delete_dc')),
   _BITMAPINFO=lambda:types.SimpleNamespace(bmiHeader=types.SimpleNamespace()),_BITMAPINFOHEADER=object,
   _POINT=lambda x,y:(x,y),_SIZE=lambda x,y:(x,y),_BLENDFUNCTION=lambda *a:a,
   _BI_RGB=0,_DIB_RGB_COLORS=0,_AC_SRC_OVER=0,_AC_SRC_ALPHA=1,_ULW_ALPHA=2)
  fake_ctypes=types.SimpleNamespace(sizeof=lambda _:40,byref=lambda x:x,c_void_p=lambda v=None:types.SimpleNamespace(value=v),memmove=call('copy_pixels'))
  self.scope={'ctypes':fake_ctypes,'threading':threading,'api':self.api}
  exec(patcher.SURFACE[patcher.SURFACE.index('class RetainedBitmap:'):],self.scope)
  self.Bitmap=self.scope['RetainedBitmap']
 def names(self):return [c[0] for c in self.calls]
 def test_animation_reuses_surface_and_keeps_alpha_uploads(self):
  bitmap=self.Bitmap(2,2,b'x'*16)
  for alpha in range(100):bitmap.draw(100,30,40,alpha)
  self.assertEqual(self.names().count('create_bitmap'),1)
  self.assertEqual(self.names().count('copy_pixels'),1)
  self.assertEqual(self.names().count('upload'),100)
  self.assertNotIn('delete_bitmap',self.names())
  uploads=[args for name,args in self.calls if name=='upload']
  self.assertEqual(uploads[-1][2],(30,40));self.assertEqual(uploads[-1][7],(0,0,99,1))
  bitmap.close();bitmap.close()
  for name in ('delete_bitmap','delete_dc','release_dc'):self.assertEqual(self.names().count(name),1)
  self.assertLess(self.names().index('delete_bitmap'),self.names().index('delete_dc'))
  with self.assertRaisesRegex(RuntimeError,'closed'):bitmap.draw(100,0,0)
 def test_partial_allocation_failure_releases_completed_resources(self):
  self.fail_bitmap=True
  with self.assertRaisesRegex(OSError,'CreateDIBSection'):self.Bitmap(2,2,b'x'*16)
  self.assertEqual(self.names().count('delete_dc'),1);self.assertEqual(self.names().count('release_dc'),1)
  self.assertNotIn('delete_bitmap',self.names())
 def test_upload_failure_still_allows_explicit_cleanup(self):
  bitmap=self.Bitmap(2,2,b'x'*16);self.fail_upload=True
  with self.assertRaisesRegex(OSError,'UpdateLayeredWindow'):bitmap.draw(100,0,0)
  bitmap.close();self.assertEqual(self.names().count('delete_bitmap'),1)
 def test_cross_thread_use_is_rejected(self):
  bitmap=self.Bitmap(2,2,b'x'*16);errors=[]
  def other():
   try:bitmap.draw(100,0,0)
   except RuntimeError as e:errors.append(str(e))
  t=threading.Thread(target=other);t.start();t.join()
  self.assertEqual(len(errors),1);self.assertNotIn('upload',self.names());bitmap.close()
 def test_unknown_layout_rejected_and_existing_patch_idempotent(self):
  with self.assertRaises(RuntimeError):patcher.transform('pass\n')
  source=patcher.IMPORT+HEALTH_CHECK
  fixed=patcher.upgrade_health_sample(source);self.assertEqual(patcher.upgrade_health_sample(fixed),fixed)
 def test_heartbeat_update_during_clock_sample_does_not_report_failure(self):
  from contextlib import nullcontext
  indicator=types.SimpleNamespace(heartbeat=9.9,thread=types.SimpleNamespace(is_alive=lambda:True),stopping=False,error=None)
  def clock():indicator.heartbeat=10.1;return 10.0
  scope={'_lock':nullcontext(),'_instance':indicator,'time':types.SimpleNamespace(monotonic=clock),'contextmanager':lambda f:f}
  fixed=patcher.upgrade_health_sample(patcher.IMPORT+HEALTH_CHECK)
  exec(fixed.replace(patcher.IMPORT,''),scope)
  self.assertTrue(scope['is_healthy']())
  indicator.heartbeat=8.0
  scope['time']=types.SimpleNamespace(monotonic=lambda:10.0)
  self.assertFalse(scope['is_healthy']())
  indicator.heartbeat=10.0;indicator.error=RuntimeError('owner failed')
  self.assertFalse(scope['is_healthy']())

 @unittest.skipUnless(sys.platform=='win32','Real Win32 renderer required')
 def test_native_owner_progress_keeps_health_without_early_visible_ack(self):
  import inspect,textwrap
  from windows_mcp.desktop import control_overlay as overlay
  clock=types.SimpleNamespace(value=0.0)
  owner=types.SimpleNamespace(active=True,pending=False,suspended=False,version=42,applied=0,stopping=False,error=None,heartbeat=0.0,started=types.SimpleNamespace(set=lambda:None))
  observations=[];acks=[]
  class Condition:
   calls=0
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def wait(self,**kwargs):
    self.calls+=1
    if self.calls>1:owner.stopping=True
   def notify_all(self):pass
  owner.condition=Condition()
  class Layer:
   breathes=True
   hwnd=100
   def progress(self,*args):
    clock.value+=0.6
    observations.append(clock.value-owner.heartbeat<=1.0)
   set_opacity=progress
   hide=progress
   def show(self):acks.append(owner.applied);self.progress()
   def close(self):pass
  layers=[Layer(),Layer(),Layer()];ring=Layer()
  scope={'time':types.SimpleNamespace(monotonic=lambda:clock.value),'_REFRESH_SECONDS':0.05,'_monitor_rects':lambda:((0,0,100,100),),'_build_layers':lambda *args:(layers,ring),'_breath_opacity':lambda _:200,'wintypes':types.SimpleNamespace(POINT=lambda:None),'_user32':types.SimpleNamespace(GetCursorPos=lambda _:False),'ctypes':types.SimpleNamespace(byref=lambda x:x),'flash_overlay':types.SimpleNamespace(_pump_messages=lambda _:None),'logger':types.SimpleNamespace(exception=lambda *args:None)}
  exec(textwrap.dedent(inspect.getsource(overlay._Indicator._run)),scope)
  scope['_run'](owner)
  self.assertIsNone(owner.error)
  self.assertTrue(observations);self.assertTrue(all(observations))
  self.assertTrue(all(ack==0 for ack in acks));self.assertEqual(owner.applied,42)
 @unittest.skipUnless(sys.platform=='win32','Real GDI resources required')
 def test_native_surface_has_no_per_frame_handle_growth(self):
  import ctypes,os
  from ctypes import wintypes
  from windows_mcp.homemcp_indicator_bitmap import RetainedBitmap
  from windows_mcp.desktop import flash_overlay as api
  ctypes.windll.kernel32.GetCurrentProcess.restype=wintypes.HANDLE
  api._user32.GetGuiResources.argtypes=[wintypes.HANDLE,wintypes.DWORD]
  api._user32.GetGuiResources.restype=wintypes.DWORD
  process=ctypes.windll.kernel32.GetCurrentProcess()
  count=lambda:api._user32.GetGuiResources(process,0)
  baseline=count()
  for cycle in range(3):
   name=f'WindowsMCPControl_bitmap_test_{os.getpid()}_{cycle}'
   hwnd,instance=api._create_layered_window(name,0,0,16,16);bitmap=None
   try:
    bitmap=RetainedBitmap(16,16,bytes([0,0,100,100])*256);allocated=count()
    for frame in range(100):bitmap.draw(hwnd,0,0,frame%256)
    self.assertEqual(count(),allocated)
   finally:
    api._user32.DestroyWindow(hwnd);api._user32.UnregisterClassW(name,instance)
    if bitmap:bitmap.close()
   self.assertEqual(count(),baseline)

if __name__=='__main__':unittest.main()
