using System.IO.Pipes;
using System.Text;

namespace SkillOrganizerForCodex.Desktop.Infrastructure;

internal sealed class SingleInstanceCoordinator : IDisposable
{
    private const string MutexName = @"Local\SkillOrganizerForCodex.Desktop.v2";
    private const string PipeName = "SkillOrganizerForCodex.Desktop.v2";
    private readonly Mutex _mutex;
    private readonly CancellationTokenSource _cancellation = new();
    private Task? _listenerTask;

    public SingleInstanceCoordinator()
    {
        _mutex = new Mutex(initiallyOwned: false, MutexName, out var createdNew);
        IsPrimary = createdNew;
    }

    public bool IsPrimary { get; }

    public event EventHandler? ActivationRequested;

    public void StartListening()
    {
        if (!IsPrimary || _listenerTask is not null)
        {
            return;
        }
        _listenerTask = ListenAsync(_cancellation.Token);
    }

    public async Task<bool> TryActivatePrimaryAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
        while (!timeout.IsCancellationRequested)
        {
            try
            {
                await using var client = new NamedPipeClientStream(
                    ".",
                    PipeName,
                    PipeDirection.Out,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await client.ConnectAsync(500, timeout.Token).ConfigureAwait(false);
                await using var writer = new StreamWriter(client, new UTF8Encoding(false), leaveOpen: false)
                {
                    AutoFlush = true,
                };
                await writer.WriteLineAsync("activate").ConfigureAwait(false);
                return true;
            }
            catch (OperationCanceledException)
            {
                return false;
            }
            catch (TimeoutException)
            {
                await Task.Delay(100, timeout.Token).ConfigureAwait(false);
            }
            catch (IOException)
            {
                await Task.Delay(100, timeout.Token).ConfigureAwait(false);
            }
        }
        return false;
    }

    private async Task ListenAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(
                    PipeName,
                    PipeDirection.In,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                using var reader = new StreamReader(server, Encoding.UTF8, leaveOpen: true);
                var command = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (command?.Equals("activate", StringComparison.Ordinal) == true)
                {
                    ActivationRequested?.Invoke(this, EventArgs.Empty);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (IOException) when (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(100, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    public void Dispose()
    {
        _cancellation.Cancel();
        try
        {
            _listenerTask?.Wait(TimeSpan.FromSeconds(1));
        }
        catch (AggregateException)
        {
            // Cancellation is expected during application shutdown.
        }
        _cancellation.Dispose();
        _mutex.Dispose();
    }
}
