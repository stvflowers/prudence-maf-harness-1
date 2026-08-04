from pathlib import Path
from sys import platform
from typing import Protocol, cast


class _WindowAttributeSetter(Protocol):
    def attributes(
        self,
        *,
        alpha: float = 1.0,
        topmost: bool = False,
    ) -> None: ...


def select_directory() -> str | None:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.title("Prudence folder picker")
    window_attributes: _WindowAttributeSetter | None = None
    if platform == "win32":
        window_attributes = cast(_WindowAttributeSetter, root)
        root.overrideredirect(True)
        root.geometry("1x1+-32000+-32000")
        try:
            window_attributes.attributes(alpha=0.0)
        except tk.TclError:
            # The off-screen geometry still keeps the owner invisible without alpha support.
            pass
        window_attributes.attributes(topmost=True)
        root.deiconify()
        root.update_idletasks()
    else:
        root.update()
    root.focus_force()
    try:
        selected = filedialog.askdirectory(
            parent=root,
            title="Select agent workspace",
            mustexist=True,
        )
    finally:
        if window_attributes is not None:
            window_attributes.attributes(topmost=False)
        root.destroy()
    if not selected:
        return None
    path = Path(selected).resolve(strict=True)
    if not path.is_dir():
        raise ValueError("Selected workspace is not a directory")
    return str(path)
