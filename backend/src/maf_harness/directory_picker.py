from pathlib import Path


def select_directory() -> str | None:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.update()
    root.focus_force()
    try:
        selected = filedialog.askdirectory(
            parent=root,
            title="Select agent workspace",
            mustexist=True,
        )
    finally:
        root.destroy()
    if not selected:
        return None
    path = Path(selected).resolve(strict=True)
    if not path.is_dir():
        raise ValueError("Selected workspace is not a directory")
    return str(path)
