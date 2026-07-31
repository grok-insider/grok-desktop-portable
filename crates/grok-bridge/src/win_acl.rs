//! Owner-only DACLs for Windows state artifacts.
//!
//! Mirrors Unix `0700` / `0600`: the current user and SYSTEM may access the
//! path; Everyone grants are refused. The DACL is protected against inheritance.

#![cfg(windows)]
// Win32 security APIs only; no user-controlled format strings.
#![allow(unsafe_code)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;

/// ACCESS_ALLOWED_ACE_TYPE from winnt.h (not always re-exported by windows-sys).
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

/// Apply an owner-only protected DACL to `path` (file or directory).
///
/// Grants full control to the **current process user** and SYSTEM. Protected
/// so parent-directory inheritance cannot re-open the object.
pub fn set_owner_only(path: &Path) -> std::io::Result<()> {
    let user_sid = current_user_sid_string()?;
    // SAFETY: SDDL built only from our well-known fragments + SID string from
    // ConvertSidToStringSid; LocalFree always pairs with ConvertString success.
    unsafe {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SE_FILE_OBJECT,
            SetNamedSecurityInfoW,
        };
        use windows_sys::Win32::Security::{
            ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        };

        let sddl = format!("D:P(A;OICI;FA;;;{user_sid})(A;OICI;FA;;;SY)");
        let sddl_wide: Vec<u16> = OsStr::new(&sddl)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let wide = wide_path(path);

        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let mut sd_size: u32 = 0;
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            1,
            &mut sd,
            &mut sd_size,
        ) == 0
            || sd.is_null()
        {
            return Err(std::io::Error::last_os_error());
        }

        let mut dacl_present: i32 = 0;
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut dacl_defaulted: i32 = 0;
        if GetSecurityDescriptorDacl(sd, &mut dacl_present, &mut dacl, &mut dacl_defaulted) == 0 {
            LocalFree(sd as *mut _);
            return Err(std::io::Error::last_os_error());
        }

        let status = SetNamedSecurityInfoW(
            wide.as_ptr() as *mut _,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            dacl,
            ptr::null_mut(),
        );
        LocalFree(sd as *mut _);

        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }
        Ok(())
    }
}

/// Whether `path` is private enough for host state.
///
/// Passes when the DACL grants no allow ACE to **Everyone** (world). Owner SID
/// matching is intentionally not required: guest-agent / service contexts and
/// interactive users both need to work after [`set_owner_only`].
pub fn is_owner_only(path: &Path) -> std::io::Result<bool> {
    // SAFETY: GetNamedSecurityInfo allocates an SD we free with LocalFree.
    unsafe {
        use windows_sys::Win32::Foundation::{ERROR_SUCCESS, LocalFree};
        use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::{
            ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
            DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation, IsValidSid,
            PSECURITY_DESCRIPTOR, PSID,
        };

        let wide = wide_path(path);
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let status = GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut sd,
        );
        if status != ERROR_SUCCESS || sd.is_null() {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }

        if dacl.is_null() {
            LocalFree(sd as *mut _);
            return Ok(false);
        }

        let mut info = ACL_SIZE_INFORMATION {
            AceCount: 0,
            AclBytesInUse: 0,
            AclBytesFree: 0,
        };
        if GetAclInformation(
            dacl,
            (&raw mut info).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        ) == 0
        {
            LocalFree(sd as *mut _);
            return Err(std::io::Error::last_os_error());
        }

        let everyone = everyone_sid();
        if everyone.is_empty() {
            LocalFree(sd as *mut _);
            return Ok(false);
        }
        let everyone_sid = everyone.as_ptr() as PSID;

        for i in 0..info.AceCount {
            let mut ace: *mut core::ffi::c_void = ptr::null_mut();
            if GetAce(dacl, i, &mut ace) == 0 || ace.is_null() {
                continue;
            }
            let header = &*(ace as *const ACE_HEADER);
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
                continue;
            }
            let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
            let ace_sid = std::ptr::addr_of!(allowed.SidStart) as PSID;
            if IsValidSid(ace_sid) != 0 && EqualSid(ace_sid, everyone_sid) != 0 {
                LocalFree(sd as *mut _);
                return Ok(false);
            }
        }

        LocalFree(sd as *mut _);
        Ok(true)
    }
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Current process user SID as `S-1-…` string.
fn current_user_sid_string() -> std::io::Result<String> {
    // SAFETY: token/SID buffers are sized via GetTokenInformation; LocalFree
    // for ConvertSidToStringSid allocation; CloseHandle for the token.
    unsafe {
        use windows_sys::Win32::Foundation::{
            CloseHandle, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
        };
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
        use windows_sys::Win32::Security::{
            GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        let mut token: HANDLE = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if token.is_null() || token == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }

        let mut needed: u32 = 0;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            CloseHandle(token);
            return Err(std::io::Error::last_os_error());
        }
        let mut buf = vec![0u8; needed as usize];
        if GetTokenInformation(
            token,
            TokenUser,
            buf.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ) == 0
        {
            CloseHandle(token);
            return Err(std::io::Error::last_os_error());
        }
        CloseHandle(token);

        let token_user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut sid_str: *mut u16 = ptr::null_mut();
        if ConvertSidToStringSidW(token_user.User.Sid, &mut sid_str) == 0 || sid_str.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut len = 0usize;
        while *sid_str.add(len) != 0 {
            len += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(sid_str, len));
        LocalFree(sid_str as *mut _);
        Ok(s)
    }
}

/// Encode the well-known Everyone SID (S-1-1-0) as a raw SID buffer.
fn everyone_sid() -> Vec<u8> {
    // SAFETY: CreateWellKnownSid with WinWorldSid fills a caller buffer.
    unsafe {
        use windows_sys::Win32::Security::{CreateWellKnownSid, WinWorldSid};

        let mut size: u32 = 68;
        let mut buf = vec![0u8; size as usize];
        if CreateWellKnownSid(
            WinWorldSid,
            ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        ) == 0
        {
            return Vec::new();
        }
        buf.truncate(size as usize);
        buf
    }
}

#[cfg(test)]
mod tests {
    use super::{is_owner_only, set_owner_only};
    use std::fs;

    #[test]
    fn freshly_secured_directory_is_owner_only() {
        let root = tempfile::tempdir().expect("tempdir");
        let dir = root.path().join("private");
        fs::create_dir_all(&dir).expect("mkdir");
        set_owner_only(&dir).expect("set acl");
        assert!(
            is_owner_only(&dir).expect("check"),
            "owner-only DACL must pass verification"
        );
    }

    #[test]
    fn freshly_secured_file_is_owner_only() {
        let root = tempfile::tempdir().expect("tempdir");
        let file = root.path().join("secret.json");
        fs::write(&file, b"{}").expect("write");
        set_owner_only(&file).expect("set acl");
        assert!(is_owner_only(&file).expect("check"));
    }

    #[test]
    fn world_readable_directory_is_rejected() {
        use std::process::Command;
        let root = tempfile::tempdir().expect("tempdir");
        let dir = root.path().join("open");
        fs::create_dir_all(&dir).expect("mkdir");
        let status = Command::new("icacls")
            .arg(&dir)
            .arg("/grant")
            .arg("Everyone:(OI)(CI)(R)")
            .status()
            .expect("icacls");
        assert!(status.success(), "icacls grant must succeed");
        assert!(
            !is_owner_only(&dir).expect("check"),
            "Everyone ACE must fail the owner-only check"
        );
    }
}
