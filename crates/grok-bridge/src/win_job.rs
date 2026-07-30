//! Windows Job Object that kills the entire process tree on drop.
//!
//! Mirrors Unix `process_group(0)` + kill-the-group: the agent may spawn
//! grandchildren (shells, tool runners). Closing the job handle with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates every process still assigned
//! to the job, including the direct `grok` child.

#![cfg(windows)]
#![allow(unsafe_code)]

use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr;

/// A job object that kills its process tree when dropped.
#[derive(Debug)]
pub struct KillOnDropJob {
    _job: OwnedHandle,
}

impl KillOnDropJob {
    /// Create a kill-on-close job and assign the process with `pid` to it.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the job cannot be created or the process
    /// cannot be assigned (already exited, access denied, etc.).
    pub fn for_pid(pid: u32) -> std::io::Result<Self> {
        // SAFETY: Job object / process handles are created and either closed on
        // error paths or moved into OwnedHandle; no raw pointers outlive the call.
        unsafe {
            use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
            use windows_sys::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            };
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
            };

            let job: HANDLE = CreateJobObjectW(ptr::null(), ptr::null());
            if job == 0 || job == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw mut info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let err = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(err);
            }

            let process: HANDLE = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process == 0 || process == INVALID_HANDLE_VALUE {
                let err = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(err);
            }

            if AssignProcessToJobObject(job, process) == 0 {
                let err = std::io::Error::last_os_error();
                CloseHandle(process);
                CloseHandle(job);
                return Err(err);
            }
            CloseHandle(process);

            let owned = OwnedHandle::from_raw_handle(job as *mut _);
            Ok(Self { _job: owned })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::KillOnDropJob;
    use std::process::Command;

    #[test]
    fn job_can_be_created_for_a_live_child() {
        // Spawn a short-lived process and attach a job; drop must not panic.
        let mut child = Command::new("cmd")
            .args(["/C", "ping", "-n", "2", "127.0.0.1", ">", "nul"])
            .spawn()
            .expect("spawn");
        let pid = child.id();
        let job = KillOnDropJob::for_pid(pid).expect("job");
        drop(job);
        let _ = child.kill();
        let _ = child.wait();
    }
}
