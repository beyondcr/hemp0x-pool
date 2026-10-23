#!/usr/bin/env python3
"""Grant the pool group read access to a daemon-owned RPC cookie."""

import argparse
import grp
import os
import stat
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cookie', required=True)
    parser.add_argument('--group', required=True)
    parser.add_argument('--wait-rpc', nargs=argparse.REMAINDER)
    args = parser.parse_args()

    if args.wait_rpc is not None:
        if not args.wait_rpc:
            parser.error('--wait-rpc requires a CLI command')
        deadline = time.monotonic() + 120
        while True:
            try:
                result = subprocess.run(args.wait_rpc, timeout=3, check=False,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if result.returncode == 0:
                    break
            except subprocess.TimeoutExpired:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError('RPC did not become ready before cookie permission repair')
            time.sleep(1)

    group_id = grp.getgrnam(args.group).gr_gid
    fd = os.open(args.cookie, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise RuntimeError('Expected a regular cookie owned by the service user')
        if info.st_gid != group_id:
            os.fchown(fd, -1, group_id)
        if stat.S_IMODE(info.st_mode) != 0o640:
            os.fchmod(fd, 0o640)
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
