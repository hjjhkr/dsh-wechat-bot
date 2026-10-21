#!/usr/bin/env node
// Stdio entry point for the simulator adapter: `node bin/simulator.js [--logged-in]`.
import { Simulator } from '../lib/simulator.js'

const simulator = new Simulator({ input: process.stdin, output: process.stdout, loggedIn: process.argv.includes('--logged-in') })
simulator.peer.closed.then(() => process.exit(0))
