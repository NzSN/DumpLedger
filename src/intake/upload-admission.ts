export interface UploadAdmissionLease { release(): void }

export class UploadAdmission {
  #active = 0;

  constructor(readonly capacity = 2) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("upload capacity must be positive");
  }

  tryAcquire(): UploadAdmissionLease | undefined {
    if (this.#active >= this.capacity) return undefined;
    this.#active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
      },
    };
  }

  snapshot(): { readonly active: number; readonly capacity: number } {
    return { active: this.#active, capacity: this.capacity };
  }
}
