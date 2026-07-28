// Thin Windows launcher for claude-budget.
//
// Windows has no LaunchAgent, and the repo's macOS scripts/ don't apply here.
// This is the equivalent front door: a tiny GUI-subsystem exe (no console
// window flashes) that makes sure the Node server is up and then opens the
// dashboard.
//
//   ClaudeBudget.exe            ensure the server is running, then open a browser
//   ClaudeBudget.exe --serve    ensure the server is running, open nothing
//
// --serve is what the Startup-folder shortcut uses, so logging in starts the
// server silently instead of ambushing you with a browser tab.
//
// Deliberately NOT a self-contained binary. A Node SEA build would be ~110MB,
// would need the server rewritten to serve web/ out of SEA assets, and would
// pull a bundler into a repo that prides itself on zero dependencies. This is
// ~10KB, compiles with the csc.exe that ships inside Windows, and needs no
// changes to the app at all. Node is already a requirement to run the server.
//
// Built by scripts/install-windows.ps1, which generates the BakedRoot partial
// alongside this file.

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

static class ClaudeBudget
{
    const int DefaultPort = 4478;

    // How long to wait for the server to answer after we spawn it. A cold
    // first scan walks every transcript under ~/.claude/projects, so this is
    // generous on purpose — a slow start is not a failed start.
    const int StartupTimeoutMs = 30000;

    [STAThread]
    static int Main(string[] args)
    {
        bool serveOnly = false;
        foreach (string a in args)
        {
            if (a == "--serve") serveOnly = true;
        }

        try
        {
            int port = ResolvePort();
            string root = ResolveRoot();

            if (!Listening(port))
            {
                string node = ResolveNode();
                Spawn(node, root, port);

                if (!WaitForPort(port, StartupTimeoutMs))
                {
                    string log = Path.Combine(root, "claude-budget.log");
                    Fail(
                        "The server did not start within "
                            + (StartupTimeoutMs / 1000)
                            + " seconds.\r\n\r\nCheck the log:\r\n"
                            + log
                    );
                    return 1;
                }
            }

            if (!serveOnly) Open("http://localhost:" + port + "/");
            return 0;
        }
        catch (Exception ex)
        {
            Fail(ex.Message);
            return 1;
        }
    }

    static int ResolvePort()
    {
        string raw = Environment.GetEnvironmentVariable("BUDGET_PORT");
        int p;
        if (!string.IsNullOrEmpty(raw) && int.TryParse(raw, out p) && p > 0 && p < 65536) return p;
        return DefaultPort;
    }

    /// <summary>
    /// Find the repo. Walking up from the exe is what keeps the launcher
    /// correct after the repo is moved or renamed; the baked path is only the
    /// fallback for when someone copies the exe somewhere else entirely.
    /// </summary>
    static string ResolveRoot()
    {
        string dir = Path.GetDirectoryName(Application.ExecutablePath);
        for (int i = 0; i < 6 && dir != null; i++)
        {
            if (File.Exists(Path.Combine(dir, "src\\server.mjs"))) return dir;
            DirectoryInfo parent = Directory.GetParent(dir);
            dir = parent == null ? null : parent.FullName;
        }

        if (!string.IsNullOrEmpty(Baked.Root) && File.Exists(Path.Combine(Baked.Root, "src\\server.mjs")))
            return Baked.Root;

        throw new Exception(
            "Could not find the claude-budget checkout.\r\n\r\nExpected src\\server.mjs at or above:\r\n"
                + Path.GetDirectoryName(Application.ExecutablePath)
                + "\r\n\r\nRe-run scripts\\install-windows.ps1 from the repo."
        );
    }

    /// <summary>
    /// PATH first so a version manager (nvm/fnm/volta) wins over a stale
    /// system install, then the usual fixed locations.
    /// </summary>
    static string ResolveNode()
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string part in path.Split(';'))
        {
            if (part.Length == 0) continue;
            string candidate;
            try { candidate = Path.Combine(part.Trim(), "node.exe"); }
            catch { continue; } // a malformed PATH entry shouldn't kill the launch
            if (File.Exists(candidate)) return candidate;
        }

        string[] fallbacks =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs\\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs\\node.exe"),
        };
        foreach (string f in fallbacks)
        {
            if (File.Exists(f)) return f;
        }

        throw new Exception(
            "Node.js was not found.\r\n\r\nclaude-budget needs Node 20 or newer on PATH.\r\nInstall it from https://nodejs.org and try again."
        );
    }

    /// <summary>
    /// Spawned through cmd.exe purely for the redirection. Redirecting the
    /// streams in-process would mean this launcher has to stay alive draining
    /// them — the child blocks once a pipe buffer fills and nobody is reading.
    /// cmd owns the file handles instead, so the launcher is free to exit.
    /// </summary>
    static void Spawn(string node, string root, int port)
    {
        string log = Path.Combine(root, "claude-budget.log");
        string command = string.Format(
            "\"\"{0}\" \"{1}\" >> \"{2}\" 2>&1\"",
            node,
            Path.Combine(root, "src\\server.mjs"),
            log
        );

        ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c " + command);
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.EnvironmentVariables["BUDGET_PORT"] = port.ToString();
        Process.Start(psi);
    }

    static bool Listening(int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(250)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch
        {
            return false;
        }
    }

    static bool WaitForPort(int port, int timeoutMs)
    {
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (Listening(port)) return true;
            Thread.Sleep(200);
        }
        return false;
    }

    static void Open(string url)
    {
        ProcessStartInfo psi = new ProcessStartInfo(url);
        psi.UseShellExecute = true;
        Process.Start(psi);
    }

    static void Fail(string message)
    {
        MessageBox.Show(message, "claude-budget", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
