import pandas as pd
import numpy as np
from prophet import Prophet

from google.colab import files
upload = files.upload()

for fn in upload.keys():
  print('User uploaded file "{name}" with length {length} bytes'.format(
      name=fn, length=len(upload[fn])))
  traffic = pd.read_csv(fn)
  traffic.head()

traffic.columns = ['ds', 'y']
traffic.head()

updates = pd.DataFrame({
    'holiday': 'Core Update',
    'ds': pd.to_datetime(['2015-07-17', '2016-01-08',
                          '2016-09-27', '2017-03-08','2017-07-09', '2018-03-08','2018-04-17',
                          '2018-08-01', '2019-03-12','2019-06-03', '2019-09-24','2019-10-25',
                          '2019-12-09', '2020-01-13','2020-05-04', '2020-12-03','2021-06-02',
                          '2021-07-01', '2021-11-17','2022-05-25', '2022-09-12','2023-03-15',
                          '2023-03-15', '2023-08-22','2023-11-02', '2024-03-05','2024-08-15',]),
    'lower_window': 0,
    'upper_window': 14,
})
updates.head()

m = Prophet(holidays=updates).fit(traffic)
future = m.make_future_dataframe(periods=365)
forecast = m.predict(future)
forecast[['ds', 'yhat', 'yhat_lower', 'yhat_upper']].tail()

from prophet.plot import plot_forecast_component
fig, ax = m.plot(forecast, xlabel='Date', ylabel='Organic Traffic')
ax.set_title('Traffic Forecast');
