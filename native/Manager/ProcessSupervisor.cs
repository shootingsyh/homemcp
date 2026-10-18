using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace HomeMCP.Processes;

// Platform boundary: the tray and lifecycle logic do not depend on Win32 APIs.
internal interface IProcessSupervisor : IDisposable
{
    Process Start(ProcessStartInfo info);
    void Stop(Process process);
}

// Windows kernel Job Object: automatically terminate all descendants on disposal.
// Child processes inherit job membership unless they explicitly request breakaway.
internal sealed class WindowsJobProcessSupervisor : IProcessSupervisor
{
    private IntPtr job;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string? name);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public WindowsJobProcessSupervisor() => job=NewJob();
    private static IntPtr NewJob() {
        var handle=CreateJobObject(IntPtr.Zero,null);
        if(handle==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateJobObject");
        var info=new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags=JobObjectLimitKillOnJobClose;
        int size=Marshal.SizeOf<ExtendedLimitInformation>();
        IntPtr ptr=Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(info,ptr,false);
            if(!SetInformationJobObject(handle,JobObjectExtendedLimitInformation,ptr,(uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error(),"SetInformationJobObject");
        }catch{CloseHandle(handle);throw;}
        finally{Marshal.FreeHGlobal(ptr);}
        return handle;
    }
    public Process Start(ProcessStartInfo info) {
        var child=Process.Start(info)??throw new InvalidOperationException("Process.Start returned null");
        try {
            if(!AssignProcessToJobObject(job,child.Handle))
                throw new Win32Exception(Marshal.GetLastWin32Error(),"AssignProcessToJobObject");
            return child;
        }catch{
            try{child.Kill(entireProcessTree:true);}catch{}
            child.Dispose();
            throw;
        }
    }
    public void Stop(Process process) {
        if(job==IntPtr.Zero)return;
        // A fresh Job handle is required for the next restart. Termination is scoped to this job.
        var old=job; job=IntPtr.Zero;
        try{if(!TerminateJobObject(old,1))throw new Win32Exception(Marshal.GetLastWin32Error(),"TerminateJobObject");}
        finally{CloseHandle(old);job=NewJob();}
    }
    public void Dispose(){if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}}
}
