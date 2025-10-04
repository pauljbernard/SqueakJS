            if (typeof obj === "string") return this.makeStString(obj);
            if (obj.constructor.name === "Uint8Array" || obj.constructor.name === "Buffer")
                return this.makeStByteArray(obj);
