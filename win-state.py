#!/usr/bin/env python
"""查抖音窗口的实际几何状态，用来判断是不是真全屏 / 最大化。"""
import ctypes
import ctypes.wintypes as wt
import sys

user32 = ctypes.windll.user32
MONITOR = ctypes.windll.user32

SW_MAXIMIZE = 3
SW_RESTORE = 9


def find_douyin():
    hits = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if "抖音" in buf.value:
            hits.append((hwnd, buf.value))
        return True

    user32.EnumWindows(cb, 0)
    return hits


def main():
    hits = find_douyin()
    if not hits:
        print("未找到抖音窗口")
        return

    for hwnd, title in hits:
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        zoomed = bool(user32.IsZoomed(hwnd))
        style = user32.GetWindowLongW(hwnd, -16)  # GWL_STYLE
        WS_MAXIMIZE = 0x01000000
        print(f"窗口 {hwnd} '{title}'")
        print(f"  矩形: {r.left},{r.top} - {r.right},{r.bottom}  ({w}x{h})")
        print(f"  IsZoomed(最大化): {zoomed}  STYLE有MAXIMIZE位: {bool(style & WS_MAXIMIZE)}")

    # 显示器信息
    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT),
                    ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]

    print("\n显示器:")
    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(MONITORINFO)

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HMONITOR, wt.HDC, ctypes.POINTER(wt.RECT), wt.LPARAM)
    def mcb(mh, hdc, rc, _):
        m = MONITORINFO()
        m.cbSize = ctypes.sizeof(MONITORINFO)
        ctypes.windll.user32.GetMonitorInfoW(mh, ctypes.byref(m))
        rw = m.rcWork.right - m.rcWork.left
        rh = m.rcWork.bottom - m.rcWork.top
        primary = bool(m.dwFlags & 1)
        print(f"  工作区: {m.rcWork.left},{m.rcWork.top} - {m.rcWork.right},{m.rcWork.bottom} ({rw}x{rh}) 主屏={primary}")
        return True

    MONITOR.EnumDisplayMonitors(None, None, mcb, None)


if __name__ == "__main__":
    main()