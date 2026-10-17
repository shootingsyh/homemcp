using System;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Native {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct STARTUPINFO {
  public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
  public int dwX; public int dwY; public int dwXSize; public int dwYSize;
  public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
  public int dwFlags; public short wShowWindow; public short cbReserved2;
  public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
 }
 [StructLayout(LayoutKind.Sequential)]
 public struct PROCESS_INFORMATION {public IntPtr hProcess;public IntPtr hThread;public uint dwProcessId;public uint dwThreadId;}
 [StructLayout(LayoutKind.Sequential)]
 public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {public long PerProcessUserTimeLimit;public long PerJobUserTimeLimit;public uint LimitFlags;public UIntPtr MinimumWorkingSetSize;public UIntPtr MaximumWorkingSetSize;public uint ActiveProcessLimit;public UIntPtr Affinity;public uint PriorityClass;public uint SchedulingClass;}
 [StructLayout(LayoutKind.Sequential)]
 public struct IO_COUNTERS {public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount;}
 [StructLayout(LayoutKind.Sequential)]
 public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;public IO_COUNTERS IoInfo;public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;}
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int klass,ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,uint len);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern bool CreateProcess(string application,string commandLine,IntPtr processAttributes,IntPtr threadAttributes,bool inheritHandles,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr process,uint exitCode);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle,uint ms);
}
public static class Program {
 static string Quote(string s) => "\"" + s.Replace("\\","\\\\").Replace("\"","\\\"") + "\"";
 public static int Main(string[] args) {
  if(args.Length < 4 || args[0]!="--parent" || !int.TryParse(args[1],out int parentPid) || args[2]!="--") {Console.Error.WriteLine("Usage: HomeMCP.JobRunner --parent PID -- executable [args...]");return 2;}
  try {
   using var parent=Process.GetProcessById(parentPid);
   var startTime=parent.StartTime.ToUniversalTime();
   IntPtr job=Native.CreateJobObject(IntPtr.Zero,null);
   if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateJobObject");
   try {
    var limits=new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags=0x2000; // KILL_ON_JOB_CLOSE
    if(!Native.SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))throw new Win32Exception(Marshal.GetLastWin32Error(),"SetInformationJobObject");
    string exe=args[3];
    string cmd=string.Join(" ",args.AsSpan(3).ToArray().Select(Quote));
    var si=new Native.STARTUPINFO{cb=Marshal.SizeOf<Native.STARTUPINFO>()};
    if(!Native.CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,false,0x00000004|0x08000000,IntPtr.Zero,Environment.CurrentDirectory,ref si,out var pi))throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateProcess");
    try {
     if(!Native.AssignProcessToJobObject(job,pi.hProcess)){Native.TerminateProcess(pi.hProcess,1);throw new Win32Exception(Marshal.GetLastWin32Error(),"AssignProcessToJobObject");}
     if(Native.ResumeThread(pi.hThread)==0xFFFFFFFF){Native.TerminateProcess(pi.hProcess,1);throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread");}
     Console.WriteLine("HOMEMCP_WORKER_PID="+pi.dwProcessId);Console.Out.Flush();
     while(true) {
      if(Native.WaitForSingleObject(pi.hProcess,500)==0)break;
      try {if(parent.HasExited || parent.StartTime.ToUniversalTime()!=startTime)break;} catch {break;}
     }
    } finally {Native.CloseHandle(pi.hThread);Native.CloseHandle(pi.hProcess);}
   } finally {Native.CloseHandle(job);}
   return 0;
  }catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
 }
}