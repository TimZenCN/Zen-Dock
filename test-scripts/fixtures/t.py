import sys, time

print("Python 中文输出测试")
for i in range(3):
    print("第 %d 行，间隔 0.3s" % (i + 1))
    time.sleep(0.3)
print("这一行走 stderr", file=sys.stderr)
sys.exit(0)
