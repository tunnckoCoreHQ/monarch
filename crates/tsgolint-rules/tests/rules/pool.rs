//! Long-lived loading threads with ts-rust's stack size. A case runs on one
//! of them, so the thread's parse cache (`tsgolint_core` host) serves the
//! fixtures and libs to every later case on that thread.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

/// A job returns whether its thread must stop.
type Job = Box<dyn FnOnce() -> bool + Send>;

pub struct LoadingThreads {
    jobs: Sender<Job>,
}

impl LoadingThreads {
    pub fn new(count: usize) -> Self {
        let (sender, receiver) = channel::<Job>();
        let receiver = Arc::new(Mutex::new(receiver));
        for _ in 0..count.max(1) {
            spawn_worker(receiver.clone());
        }
        Self { jobs: sender }
    }

    /// Runs `f` on a loading thread and returns its result, or the panic
    /// message.
    pub fn run<R: Send + 'static>(
        &self,
        f: impl FnOnce() -> R + Send + 'static,
    ) -> Result<R, String> {
        let (sender, receiver) = channel();
        let job: Job = Box::new(move || {
            let result =
                catch_unwind(AssertUnwindSafe(f)).map_err(|payload| panic_message(&*payload));
            // A panic can leave ts-rust's thread state half done: this
            // thread stops and a new one takes its place.
            let retire = result.is_err();
            let _ = sender.send(result);
            retire
        });
        self.jobs.send(job).expect("loading threads stopped");
        receiver
            .recv()
            .map_err(|_| "the loading thread stopped".to_owned())?
    }
}

fn spawn_worker(receiver: Arc<Mutex<Receiver<Job>>>) {
    std::thread::Builder::new()
        .name("loading".to_owned())
        .stack_size(goport_core::gostd::stack::max_stack_size())
        .spawn(move || {
            loop {
                let job = match receiver.lock().unwrap().recv() {
                    Ok(job) => job,
                    Err(_) => return,
                };
                if job() {
                    spawn_worker(receiver);
                    return;
                }
            }
        })
        .expect("spawn a loading thread");
}

pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else if let Some(panic) = payload.downcast_ref::<goport_core::core::GoPanic>() {
        format!("{} ({})", panic.message, panic.location)
    } else {
        "unknown panic".to_owned()
    }
}
