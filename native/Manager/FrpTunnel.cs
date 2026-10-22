using System;
using System.Runtime.InteropServices;
namespace HomeMCP.Manager;
internal static class FrpTunnel {
 [DllImport("homemcp-frp.dll",CallingConvention=CallingConvention.Cdecl)] private static extern int StartTunnel([MarshalAs(UnmanagedType.LPUTF8Str)] string config);
 [DllImport("homemcp-frp.dll",CallingConvention=CallingConvention.Cdecl)] private static extern int StopTunnel();
 [DllImport("homemcp-frp.dll",CallingConvention=CallingConvention.Cdecl)] private static extern IntPtr TunnelStatus();
 [DllImport("homemcp-frp.dll",CallingConvention=CallingConvention.Cdecl)] private static extern void FreeTunnelString(IntPtr value);
 public static void Start(string config){var rc=StartTunnel(config);if(rc!=0)throw new InvalidOperationException($"FRP startup failed (code {rc})");}
 public static void Stop(){var rc=StopTunnel();if(rc!=0)throw new InvalidOperationException($"FRP shutdown failed (code {rc})");}
 public static string Status(){var p=TunnelStatus();try{return Marshal.PtrToStringUTF8(p)??"unknown";}finally{if(p!=IntPtr.Zero)FreeTunnelString(p);}}
}
