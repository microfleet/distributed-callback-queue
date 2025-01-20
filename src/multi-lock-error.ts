/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import type { Lock } from '@microfleet/ioredis-lock'

// for counting error nesting
let level = 0

export interface MultiLockError extends Array<Error> {}

// aggregate error
export class MultiLockError extends Error {
  public locks: Lock[]
  public name: string
  public length = 0

  constructor(errors: Error[], locks: Lock[]) {
    super()
    this.name = 'MultiLockError'
    this.locks = locks
    this.push(...errors)
  }

  toString() {
    let indent = Array(level * 4 + 1).join(" ")
    let ret = "\n" + indent + "AggregateError of:" + "\n"
    let str
    let lines
    let j
    level++
    indent = Array(level * 4 + 1).join(" ")
    for (let i = 0; i < this.length; ++i) {
        str = this[i] === this ? "[Circular AggregateError]" : this[i] + ""
        lines = str.split("\n")
        for (j = 0; j < lines.length; ++j) {
            lines[j] = indent + lines[j]
        }
        str = lines.join("\n")
        ret += str + "\n"
    }
    level--
    return ret
  }
}

const methods = ("join pop push shift unshift slice filter forEach some " +
    "every map indexOf lastIndexOf reduce reduceRight sort reverse").split(" ")

for (let i = 0; i < methods.length; ++i) {
  const method = methods[i]
  // @ts-expect-error invalid signature
  if (typeof Array.prototype[method] === "function") {
    // @ts-expect-error invalid signature
      MultiLockError.prototype[method] = Array.prototype[method]
  }
}
